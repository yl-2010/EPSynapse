import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var showSettings = false
    @State private var showPulse = false
    @StateObject private var pulse = PulseStore()

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var pagePad: CGFloat {
        AdaptiveLayout.pagePadding(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("EPSynapse")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(EPSTheme.accent)
                        .tracking(0.8)
                        .padding(.bottom, 2)
                        .id("home-top")

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
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.never)
            .onReceive(NotificationCenter.default.publisher(for: .epsScrollHomeToTop)) { _ in
                withAnimation(.easeOut(duration: 0.35)) {
                    proxy.scrollTo("home-top", anchor: .top)
                }
            }
        }
        .refreshable {
            await pulse.load(sessionId: session.sessionId)
            guard session.isSignedIn else { return }
            await dashboard.load(from: session)
        }
        .task {
            await session.boot()
            await pulse.load(sessionId: session.sessionId)
            if session.isSignedIn {
                await dashboard.load(from: session)
            }
        }
        .onChange(of: session.isSignedIn) { _, signedIn in
            Task { await pulse.load(sessionId: session.sessionId) }
            if signedIn {
                Task { await dashboard.load(from: session) }
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
        .sheet(isPresented: $showPulse) {
            PulseSheet(isPresented: $showPulse, store: pulse, sessionId: session.sessionId)
        }
    }

    @ViewBuilder
    private var dashboardContent: some View {
        PulseCard(store: pulse, slim: true) {
            showPulse = true
        }
        if isWide {
            HStack(alignment: .top, spacing: 16) {
                VStack(spacing: 16) {
                    TodoPanel()
                    CompletedPanel()
                }
                .frame(maxWidth: .infinity, alignment: .top)
                VStack(spacing: 16) {
                    ClassesPanel()
                    DatesPanel()
                    FilesPanel()
                    MailPanel()
                }
                .frame(maxWidth: .infinity, alignment: .top)
            }
        } else {
            VStack(spacing: 16) {
                TodoPanel()
                ClassesPanel()
                DatesPanel()
                FilesPanel()
                MailPanel()
                CompletedPanel()
            }
        }
    }

    private var signedOutContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            PulseCard(store: pulse, slim: false) {
                showPulse = true
            }

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
        }
    }
}
