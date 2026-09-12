import SwiftUI
import UIKit

@main
struct EPSynapseApp: App {
    @StateObject private var themeStore = ThemeStore()
    @StateObject private var sessionStore = SessionStore.shared
    @StateObject private var dashboardStore = DashboardStore()
    @State private var showLaunchCover = true

    init() {
        UIWindow.appearance().backgroundColor = EPSTheme.windowBackground
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(themeStore)
                .environmentObject(sessionStore)
                .environmentObject(dashboardStore)
                .preferredColorScheme(themeStore.colorScheme)
                .tint(EPSTheme.accent)
                .overlay {
                    if showLaunchCover {
                        AppLoadingScreen()
                            .transition(.opacity)
                    }
                }
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
                        withAnimation(.easeOut(duration: 0.22)) {
                            showLaunchCover = false
                        }
                    }
                }
        }
    }
}
