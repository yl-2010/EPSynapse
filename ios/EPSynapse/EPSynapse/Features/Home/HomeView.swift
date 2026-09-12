import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var showSettings = false

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
            await dashboard.load(from: session)
        }
        .task {
            await session.boot()
            await dashboard.load(from: session)
            if session.profile == nil {
                showSettings = true
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
}
