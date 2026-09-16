import SwiftUI

@MainActor
final class HomeFocusStore: ObservableObject {
    @Published var path: [HomeDestination] = []
    @Published var visiblePageIsAtTop = true
    @Published var scrollToTopGeneration = 0

    func handleTabReselect() {
        if !visiblePageIsAtTop {
            scrollToTopGeneration += 1
            return
        }
        guard !path.isEmpty else { return }
        var next = path
        next.removeLast()
        let transaction = Transaction(animation: .easeInOut(duration: 0.28))
        withTransaction(transaction) {
            path = next
        }
    }

    var isShowingDashboard: Bool { path.isEmpty }

    func isShowingClass(_ id: String) -> Bool {
        if case .schoolClass(let classId) = path.last { return classId == id }
        return false
    }

    func isShowingNote(_ id: String) -> Bool {
        if case .note(let noteId) = path.last { return noteId == id }
        return false
    }

    func isShowingTodo(_ id: String) -> Bool {
        if case .todo(let todoId) = path.last { return todoId == id }
        return false
    }
}

extension View {
    /// Track scroll offset for Home tab re-taps: scroll to top if needed,
    /// otherwise the store pops. Only the visible page writes `visiblePageIsAtTop`.
    func homeTabReselectScroll(isActive: Bool) -> some View {
        modifier(HomeTabScrollModifier(isActive: isActive))
    }
}

private struct HomeTabScrollModifier: ViewModifier {
    @EnvironmentObject private var homeFocus: HomeFocusStore
    let isActive: Bool
    @State private var scrollPosition = ScrollPosition(edge: .top)
    @State private var localIsAtTop = true

    private static let topSlop: CGFloat = 24

    func body(content: Content) -> some View {
        content
            .scrollPosition($scrollPosition)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.contentInsets.top <= Self.topSlop
            } action: { _, atTop in
                localIsAtTop = atTop
                if isActive {
                    homeFocus.visiblePageIsAtTop = atTop
                }
            }
            .onChange(of: isActive) { _, active in
                if active {
                    homeFocus.visiblePageIsAtTop = localIsAtTop
                }
            }
            .onChange(of: homeFocus.scrollToTopGeneration) { _, _ in
                guard isActive else { return }
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    scrollPosition.scrollTo(edge: .top)
                }
            }
            .onAppear {
                if isActive {
                    homeFocus.visiblePageIsAtTop = localIsAtTop
                }
            }
    }
}
