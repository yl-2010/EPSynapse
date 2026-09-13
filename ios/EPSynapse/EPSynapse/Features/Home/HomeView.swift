import SwiftUI
import UIKit

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.openURL) private var openURL

    @State private var showSettings = false
    @State private var scrollToTopTick = 0
    @State private var path = NavigationPath()
    /// Which front door is open on the logged-out screen. nil shows both buttons.
    @State private var openDoor: SessionStore.Door?

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var pagePad: CGFloat {
        AdaptiveLayout.pagePadding(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("EPSynapse")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(EPSTheme.accent)
                        .tracking(0.8)
                        .padding(.bottom, 2)

                    if session.isPaused {
                        pausedContent
                    } else if session.isSignedIn {
                        dashboardContent
                    } else {
                        signedOutContent
                    }
                }
                .padding(.horizontal, pagePad)
                .padding(.top, AdaptiveLayout.isPad ? 96 : 88)
                .padding(.bottom, 108)
                .frame(maxWidth: AdaptiveLayout.pageMaxWidth)
                .frame(maxWidth: .infinity)
                .background {
                    ScrollToTopBridge(tick: scrollToTopTick)
                        .frame(width: 0, height: 0)
                        .accessibilityHidden(true)
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.never)
            .epsVerticalScrollOnly()
            .refreshable {
                if session.isPaused {
                    await session.reloadMe()
                    return
                }
                guard session.isSignedIn else { return }
                await dashboard.load(from: session)
            }
            .toolbar(.hidden, for: .navigationBar)
            .epsPageBackground()
            .navigationDestination(for: HomeDestination.self) { destination in
                switch destination {
                case .schoolClass(let id):
                    ClassView(classId: id)
                case .note(let id):
                    NoteView(noteId: id)
                case .todo(let id):
                    TodoView(todoId: id)
                }
            }
        }
        .onAppear {
            dashboard.stackDepth = path.count
        }
        .onChange(of: path.count) { _, count in
            dashboard.stackDepth = count
            if count == 0 { dashboard.uiContext = .home() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .epsScrollHomeToTop)) { _ in
            if !path.isEmpty {
                path = NavigationPath()
            }
            scrollToTopTick += 1
        }
        .onReceive(NotificationCenter.default.publisher(for: .epsAgentNavigate)) { note in
            guard let info = note.object as? [String: Any] else { return }
            let view = (info["view"] as? String ?? "").lowercased()
            if view == "class", let id = info["classId"] as? String, !id.isEmpty {
                path.append(HomeDestination.schoolClass(id))
            } else if view == "note", let id = info["noteId"] as? String, !id.isEmpty {
                path.append(HomeDestination.note(id))
            } else if view == "todo", let id = info["todoId"] as? String, !id.isEmpty {
                path.append(HomeDestination.todo(id))
            } else if view == "home" {
                path = NavigationPath()
            }
        }
        .task {
            // Only the "other" door is remembered. The EPS panel never opens on its own.
            if session.door == .other { openDoor = .other }
            // Profile is nil at launch, so boot() normally flips isSignedIn
            // from false to true and onChange(isSignedIn) loads the dashboard.
            // Only load here when the state did not flip, otherwise every
            // launch fires two full dashboard fetches in parallel.
            let wasSignedIn = session.canUseDashboard
            await session.boot()
            if session.canUseDashboard, wasSignedIn {
                await dashboard.load(from: session)
            }
        }
        .onChange(of: session.canUseDashboard) { _, ready in
            if ready {
                Task { await dashboard.load(from: session) }
            } else {
                path = NavigationPath()
                ChatStore.shared.resetForSignOut()
                // Signed out or paused. Clear every list so the next account,
                // or this one once the hold lifts, does not see stale data.
                dashboard.clear()
            }
        }
        .onChange(of: session.isSignedIn) { _, signedIn in
            if !signedIn, session.door == .other {
                openDoor = .other
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .epsOpenSettings)) { _ in
            showSettings = true
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet(isPresented: $showSettings)
                .environmentObject(session)
                .environmentObject(dashboard)
        }
    }

    @ViewBuilder
    private var dashboardContent: some View {
        if isWide {
            HStack(alignment: .top, spacing: 16) {
                VStack(spacing: 16) {
                    TodoPanel()
                    CompletedPanel()
                }
                .frame(maxWidth: .infinity, alignment: .top)
                VStack(spacing: 16) {
                    ClassesPanel()
                    NotesPanel(path: $path)
                }
                .frame(maxWidth: .infinity, alignment: .top)
            }
        } else {
            VStack(spacing: 16) {
                TodoPanel()
                ClassesPanel()
                NotesPanel(path: $path)
                CompletedPanel()
            }
        }
    }

    // MARK: Logged out

    private var signedOutContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch openDoor {
            case nil:
                doorPicker
            case .eps?:
                epsComingSoon
            case .other?:
                otherSchoolSignIn
            }

            Button {
                openURL(EPSLinks.research)
            } label: {
                Text("Research")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
            .accessibilityHint("Opens the public research page in Safari")
        }
        .animation(.spring(response: 0.34, dampingFraction: 0.86), value: openDoor)
    }

    private var doorPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            doorRow(
                title: "Continue as an Eastside Prep student",
                meta: "School Microsoft account. Coming soon."
            ) {
                // Coming soon. Show the panel, never start a sign-in, never persist.
                openDoor = .eps
            }
            doorRow(
                title: "I'm a student at another school",
                meta: "Sign in with Google."
            ) {
                session.chooseDoor(.other)
                openDoor = .other
            }
        }
    }

    private func doorRow(title: String, meta: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                        .multilineTextAlignment(.leading)
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(EPSTheme.muted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, interactive: true)
        .epsHapticNavigation()
        .accessibilityHint(meta)
    }

    private var epsComingSoon: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("EPS sign-in is coming soon")
                .font(.title3.weight(.bold))
                .foregroundStyle(EPSTheme.fg)
            Text("Eastside Prep students will sign in with their @eastsideprep.org Microsoft account. That one step pulls in your four11 schedule and connects OneDrive, OneNote, Outlook, and Teams. School IT is approving the app now.")
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            backButton
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 16, interactive: false)
    }

    private var otherSchoolSignIn: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                Task { await session.signInWithGoogle() }
            } label: {
                Text("Sign in with Google")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
            .epsHapticOnTap()

            Text("Sign in with Google. You'll upload your schedule and add your own API keys in Settings.")
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
                .fixedSize(horizontal: false, vertical: true)

            if !session.settingsStatus.isEmpty {
                Text(session.settingsStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }

            backButton
        }
    }

    private var backButton: some View {
        Button {
            session.chooseDoor(nil)
            openDoor = nil
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 11, weight: .bold))
                Text("Back")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(EPSTheme.fg)
        }
        .buttonStyle(.plain)
        .epsHapticOnTap()
        .accessibilityLabel("Back to sign-in options")
    }

    // MARK: Paused

    private var pausedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let profile = session.profile {
                HStack(alignment: .center, spacing: 12) {
                    profilePicture(profile.picture)
                    VStack(alignment: .leading, spacing: 2) {
                        if !profile.signedInName.isEmpty {
                            Text(profile.signedInName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(EPSTheme.fg)
                        }
                        if !profile.email.isEmpty {
                            Text(profile.email)
                                .font(.footnote)
                                .foregroundStyle(EPSTheme.muted)
                        }
                    }
                }
            }

            Text("Almost ready")
                .font(.title3.weight(.bold))
                .foregroundStyle(EPSTheme.fg)

            if let message = session.profile?.pausedMessage, !message.isEmpty {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            Button {
                Task { await session.logout() }
            } label: {
                Text("Sign out")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
            .epsHapticOnTap()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 16, interactive: false)
    }

    @ViewBuilder
    private func profilePicture(_ raw: String) -> some View {
        if let url = URL(string: raw), !raw.isEmpty {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                default:
                    Circle().fill(EPSTheme.accent.opacity(0.35))
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
        }
    }

    private var goldLabel: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? .white
                : UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
        })
    }
}

/// Walks up to the real UIScrollView and sets contentOffset to the finger-rest top.
private struct ScrollToTopBridge: UIViewRepresentable {
    var tick: Int

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        guard tick > 0, context.coordinator.lastTick != tick else { return }
        context.coordinator.lastTick = tick
        DispatchQueue.main.async {
            var node: UIView? = uiView
            while let current = node {
                if let scroll = current as? UIScrollView {
                    EPSScrollAxis.lockVertical(scroll)
                    let top = CGPoint(x: 0, y: -scroll.adjustedContentInset.top)
                    UIView.animate(
                        withDuration: 0.35,
                        delay: 0,
                        options: [.curveEaseOut, .allowUserInteraction]
                    ) {
                        scroll.contentOffset = top
                    }
                    return
                }
                node = current.superview
            }
        }
    }

    final class Coordinator {
        var lastTick = 0
    }
}
