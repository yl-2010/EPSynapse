import SwiftUI

enum RootTab: Hashable {
    case home
    case chat
    case account
}

@MainActor
final class AppNavigationStore: ObservableObject {
    static let shared = AppNavigationStore()

    @Published var selectedTab: RootTab = .home
    @Published var tabReselectGeneration = 0

    private init() {}

    func noteTabReselect() {
        tabReselectGeneration += 1
    }

    func openChat() {
        selectedTab = .chat
    }

    func openHome() {
        selectedTab = .home
    }

    func openAccount() {
        selectedTab = .account
    }
}

struct RootTabView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if AdaptiveLayout.isPhone {
                phoneTabView
            } else {
                padTabView
            }
        }
        .modifier(AdaptiveTabStyleModifier())
        .modifier(LiquidTabBarModifier(selectedTab: nav.selectedTab))
        .background {
            TabReselectObserver {
                nav.noteTabReselect()
            }
        }
        .background {
            if AdaptiveLayout.isPad {
                PadTabBarPin()
            }
        }
        .background(EPSTheme.pageFill(colorScheme).ignoresSafeArea())
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onAppear {
            EPSHaptics.prepareSession()
            if session.canUseDashboard, nav.selectedTab == .home {
                nav.selectedTab = .chat
            }
        }
        .onChange(of: session.canUseDashboard) { _, ready in
            if ready, nav.selectedTab == .home {
                nav.selectedTab = .chat
            }
            if !ready {
                nav.selectedTab = .home
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            EPSHaptics.prepareSession()
        }
    }

    private var phoneTabView: some View {
        TabView(selection: $nav.selectedTab) {
            Tab("Account", systemImage: "person.crop.circle", value: RootTab.account) {
                SettingsView()
            }
            Tab("Home", systemImage: "graduationcap.fill", value: RootTab.home) {
                HomeView()
            }
            if #available(iOS 27, *) {
                Tab(
                    "Chat",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    value: RootTab.chat,
                    role: .prominent
                ) {
                    ChatView()
                }
            } else {
                Tab(
                    "Chat",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    value: RootTab.chat
                ) {
                    ChatView()
                }
            }
        }
    }

    private var padTabView: some View {
        TabView(selection: $nav.selectedTab) {
            Tab("Account", systemImage: "person.crop.circle", value: RootTab.account) {
                SettingsView()
            }
            Tab("Home", systemImage: "graduationcap.fill", value: RootTab.home) {
                HomeView()
            }
            Tab(
                "Chat",
                systemImage: "bubble.left.and.bubble.right.fill",
                value: RootTab.chat
            ) {
                ChatView()
            }
        }
        .defaultAdaptableTabBarPlacement(.tabBar)
    }
}

private struct AdaptiveTabStyleModifier: ViewModifier {
    func body(content: Content) -> some View {
        if AdaptiveLayout.isPad {
            if #available(iOS 27, *) {
                content
                    .tabViewStyle(.sidebarAdaptable)
                    .defaultAdaptableTabBarPlacement(.tabBar)
                    .defaultTabBarPlacement(.tabBar)
            } else {
                content
                    .tabViewStyle(.sidebarAdaptable)
                    .defaultAdaptableTabBarPlacement(.tabBar)
            }
        } else {
            content
        }
    }
}

private struct LiquidTabBarModifier: ViewModifier {
    let selectedTab: RootTab

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .tabBarMinimizeBehavior(selectedTab == .home ? .onScrollDown : .never)
        } else {
            content
        }
    }
}

extension View {
    func tabReselectScrollToTop(for tab: RootTab) -> some View {
        modifier(TabReselectScrollToTopModifier(tab: tab))
    }
}

private struct TabReselectScrollToTopModifier: ViewModifier {
    @EnvironmentObject private var nav: AppNavigationStore
    let tab: RootTab
    @State private var scrollPosition = ScrollPosition(edge: .top)

    func body(content: Content) -> some View {
        content
            .scrollPosition($scrollPosition)
            .onChange(of: nav.tabReselectGeneration) { _, _ in
                guard nav.selectedTab == tab else { return }
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    scrollPosition.scrollTo(edge: .top)
                }
            }
    }
}
