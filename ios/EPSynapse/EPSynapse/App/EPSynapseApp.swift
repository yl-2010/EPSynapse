import GoogleSignIn
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        applyPlistGoogleConfig()
        return true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        if SessionStore.isMicrosoftCallback(url) {
            Task { @MainActor in
                await SessionStore.shared.handleMicrosoftCallback(url)
            }
            return true
        }
        return GIDSignIn.sharedInstance.handle(url)
    }

    private func applyPlistGoogleConfig() {
        let iosId = plistValue("GIDClientID") ?? plistValue("EPSGoogleiOSClientID")
        guard let iosId else { return }
        let server = plistValue("GIDServerClientID")
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(
            clientID: iosId,
            serverClientID: server
        )
    }

    private func plistValue(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

@main
struct EPSynapseApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var themeStore = ThemeStore()
    @StateObject private var sessionStore = SessionStore.shared
    @StateObject private var dashboardStore = DashboardStore()
    @StateObject private var chatStore = ChatStore.shared
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
                .environmentObject(chatStore)
                .preferredColorScheme(themeStore.colorScheme)
                .tint(EPSTheme.accent)
                .onOpenURL { url in
                    // epsynapse://ms?... comes back from the Microsoft sign-in when the
                    // redirect lands outside the in-app web sheet.
                    if SessionStore.isMicrosoftCallback(url) {
                        Task { await sessionStore.handleMicrosoftCallback(url) }
                        return
                    }
                    GIDSignIn.sharedInstance.handle(url)
                }
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
