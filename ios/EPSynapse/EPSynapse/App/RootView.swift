import SwiftUI

struct RootView: View {
    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        ZStack {
            HomeView()
            CornerChrome()
            ChatHistoryOverlay()
        }
        .chatHistoryOpenGesture()
        .dismissKeyboardOnOutsideTap()
        .epsPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await chat.loadList()
        }
        .onChange(of: session.isSignedIn) { _, _ in
            Task { await chat.loadList() }
        }
    }
}
