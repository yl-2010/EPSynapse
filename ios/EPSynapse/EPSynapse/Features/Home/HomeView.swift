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

                    if session.isSignedIn {
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
                guard session.isSignedIn else { return }
                await dashboard.load(from: session)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: HomeDestination.self) { destination in
                switch destination {
                case .schoolClass(let id):
                    ClassView(classId: id)
                case .note(let id):
                    NoteView(noteId: id)
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .epsScrollHomeToTop)) { _ in
            if !path.isEmpty {
                path = NavigationPath()
            }
            scrollToTopTick += 1
        }
        .task {
            await session.boot()
            if session.isSignedIn {
                await dashboard.load(from: session)
            }
        }
        .onChange(of: session.isSignedIn) { _, signedIn in
            if signedIn {
                Task { await dashboard.load(from: session) }
            } else {
                path = NavigationPath()
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
                    NotesPanel(path: $path)
                    CompletedPanel()
                }
                .frame(maxWidth: .infinity, alignment: .top)
                VStack(spacing: 16) {
                    ClassesPanel()
                }
                .frame(maxWidth: .infinity, alignment: .top)
            }
        } else {
            VStack(spacing: 16) {
                TodoPanel()
                NotesPanel(path: $path)
                ClassesPanel()
                CompletedPanel()
            }
        }
    }

    private var signedOutContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                Task { await session.signInWithGoogle() }
            } label: {
                Text("Sign in with Google")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
            .epsHapticOnTap()

            if !session.settingsStatus.isEmpty {
                Text(session.settingsStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }

            Button {
                openURL(EPSLinks.research)
            } label: {
                Text("Research")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, interactive: true)
            .accessibilityHint("Opens the public research page in Safari")
        }
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
