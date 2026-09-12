import Combine
import Foundation
import SwiftUI

@MainActor
final class ChatStore: ObservableObject {
    static let shared = ChatStore()

    @Published var chats: [ChatListItem] = []
    @Published var currentSessionId: String?
    @Published var turns: [ChatTurn] = []
    @Published var busy = false {
        didSet {
            guard oldValue != busy else { return }
            Task { @MainActor in
                refreshWorking()
            }
        }
    }
    @Published var historyReveal: CGFloat = 0
    @Published var historyDragging = false
    @Published var historyLoading = false
    @Published var historyPanelWidth: CGFloat = 280
    @Published var wantsChatOpen = false
    @Published var composerOpen = false
    @Published var keyboardScrubLift: CGFloat = 0

    private let api = APIClient.shared
    private let defaults = UserDefaults.standard
    private let cacheKey = "epsynapse.chat.threads"

    func newChat() {
        let snapshot = turns
        let sid = currentSessionId
        turns = []
        currentSessionId = nil
        busy = false
        wantsChatOpen = true
        guard !snapshot.isEmpty else { return }
        Task {
            await persist(turns: snapshot, sessionId: sid)
            if let sid { await markRead(sid) }
        }
    }

    func persistCurrent() async {
        await persist(turns: turns, sessionId: currentSessionId)
    }

    func loadList() async {
        historyLoading = true
        defer { historyLoading = false }
        let sid = SessionStore.shared.sessionId
        guard !sid.isEmpty else {
            applyLocalList()
            return
        }
        do {
            let response = try await api.listChats(sessionId: sid)
            applyRemoteList(response.chats)
        } catch {
            applyLocalList()
        }
    }

    func resume(sessionId: String) async {
        let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty else { return }
        currentSessionId = sid
        if let remote = await loadRemoteChat(sid) {
            turns = remote
        } else if let local = cachedThread(id: sid) {
            turns = local.messages.map { ChatTurn(role: $0.role, content: $0.content) }
        } else {
            turns = []
        }
        markListRead(sid)
        wantsChatOpen = true
        setHistoryOpen(false)
        await markRead(sid)
    }

    func markRead(_ sessionId: String) async {
        let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty else { return }
        markListRead(sid)
        markCacheRead(sid)
        let auth = SessionStore.shared.sessionId
        guard !auth.isEmpty else { return }
        try? await api.markChatRead(id: sid, sessionId: auth)
    }

    func mutateTurn(id: UUID, _ body: (inout ChatTurn) -> Void) {
        guard let index = turns.firstIndex(where: { $0.id == id }) else { return }
        objectWillChange.send()
        body(&turns[index])
    }

    func setHistoryOpen(_ open: Bool) {
        let wasOpen = historyReveal > 0.5
        historyDragging = false
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            historyReveal = open ? 1 : 0
        }
        if wasOpen && !open, !busy, let sid = currentSessionId {
            Task { await markRead(sid) }
        }
    }

    private func persist(turns snapshot: [ChatTurn], sessionId: String?) async {
        let messages = snapshot
            .map { ChatMessageBody(role: $0.role, content: $0.content) }
            .filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !messages.isEmpty else { return }

        let title = Self.title(from: snapshot)
        let auth = SessionStore.shared.sessionId
        if !auth.isEmpty {
            do {
                let saved = try await api.persistChat(
                    ChatPersistBody(sessionId: sessionId, messages: messages, title: title),
                    sessionId: auth
                )
                if Self.shouldAdoptSession(current: currentSessionId, persisted: sessionId, saved: saved.sessionId) {
                    currentSessionId = saved.sessionId
                }
                let existing = cachedThread(id: saved.sessionId)
                let lastRead = Self.lastReadOnPersist(existing: existing, now: ChatISODate.date(from: saved.updated))
                var item = ChatListItem(saved)
                item.unread = saved.unread
                item.working = busy && saved.sessionId == currentSessionId
                upsert(item, messages: messages, started: existing?.started, lastRead: lastRead)
                if currentSessionId == saved.sessionId, historyReveal < 0.5, !busy {
                    await markRead(saved.sessionId)
                }
                return
            } catch {
                // Signed out or the Mac API is down. Keep the thread on device.
            }
        }

        let id = sessionId?.isEmpty == false ? sessionId! : UUID().uuidString.lowercased()
        if Self.shouldAdoptSession(current: currentSessionId, persisted: sessionId, saved: id) {
            currentSessionId = id
        }
        let now = Date()
        let existing = cachedThread(id: id)
        let lastRead = Self.lastReadOnPersist(existing: existing, now: now)
        let item = ChatListItem(
            sessionId: id,
            title: title,
            preview: messages.last?.content ?? "",
            updated: now,
            unread: Self.isUnread(updated: now, lastRead: lastRead),
            working: busy && id == currentSessionId
        )
        upsert(item, messages: messages, started: existing?.started, lastRead: lastRead)
        if currentSessionId == id, historyReveal < 0.5, !busy {
            await markRead(id)
        }
    }

    private func loadRemoteChat(_ id: String) async -> [ChatTurn]? {
        let auth = SessionStore.shared.sessionId
        guard !auth.isEmpty else { return nil }
        do {
            let detail = try await api.loadChat(id: id, sessionId: auth)
            return detail.messages.map { ChatTurn(role: $0.role, content: $0.content) }
        } catch {
            return nil
        }
    }

    private func applyRemoteList(_ rows: [ChatListItemResponse]) {
        let items = rows.map(ChatListItem.init)
        chats = items.map { item in
            var copy = item
            copy.working = busy && item.sessionId == currentSessionId
            if copy.working { copy.unread = false }
            return copy
        }
        mergeCache(from: rows)
    }

    private func applyLocalList() {
        chats = loadCache().map { cached in
            ChatListItem(
                sessionId: cached.sessionId,
                title: cached.title,
                preview: cached.preview,
                updated: ChatISODate.date(from: cached.updated),
                unread: Self.cachedUnread(cached),
                working: busy && cached.sessionId == currentSessionId
            )
        }
        .sorted { $0.updated > $1.updated }
    }

    private func upsert(
        _ item: ChatListItem,
        messages: [ChatMessageBody],
        started: String? = nil,
        lastRead: String? = nil
    ) {
        var next = item
        next.working = busy && item.sessionId == currentSessionId
        if next.working { next.unread = false }
        if let index = chats.firstIndex(where: { $0.sessionId == item.sessionId }) {
            chats[index] = next
        } else {
            chats.insert(next, at: 0)
        }
        chats.sort { $0.updated > $1.updated }

        var cache = loadCache()
        let startedISO = started ?? cache.first(where: { $0.sessionId == item.sessionId })?.started ?? ChatISODate.string(from: item.updated)
        let keptRead = lastRead ?? cache.first(where: { $0.sessionId == item.sessionId })?.lastRead
        let row = CachedChat(
            sessionId: item.sessionId,
            title: item.title,
            preview: item.preview,
            started: startedISO,
            updated: ChatISODate.string(from: item.updated),
            lastRead: keptRead,
            unread: next.unread,
            messages: messages
        )
        if let index = cache.firstIndex(where: { $0.sessionId == item.sessionId }) {
            cache[index] = row
        } else {
            cache.insert(row, at: 0)
        }
        cache.sort { $0.updated > $1.updated }
        saveCache(cache)
    }

    private func refreshWorking() {
        chats = chats.map { item in
            var copy = item
            let workingNow = busy && item.sessionId == currentSessionId
            if copy.working && !workingNow {
                copy.unread = true
            }
            copy.working = workingNow
            if workingNow { copy.unread = false }
            return copy
        }
    }

    private func markListRead(_ sessionId: String) {
        if let index = chats.firstIndex(where: { $0.sessionId == sessionId }) {
            chats[index].unread = false
        }
    }

    private func markCacheRead(_ sessionId: String) {
        var cache = loadCache()
        guard let index = cache.firstIndex(where: { $0.sessionId == sessionId }) else { return }
        cache[index].unread = false
        cache[index].lastRead = ChatISODate.string(from: Date())
        saveCache(cache)
    }

    private func mergeCache(from rows: [ChatListItemResponse]) {
        var cache = loadCache()
        for row in rows {
            if let index = cache.firstIndex(where: { $0.sessionId == row.sessionId }) {
                cache[index].title = row.title
                cache[index].preview = row.preview
                cache[index].started = row.started.isEmpty ? cache[index].started : row.started
                cache[index].updated = row.updated
                cache[index].unread = row.unread
                if !row.unread {
                    cache[index].lastRead = row.updated
                }
            } else {
                cache.append(
                    CachedChat(
                        sessionId: row.sessionId,
                        title: row.title,
                        preview: row.preview,
                        started: row.started,
                        updated: row.updated,
                        lastRead: row.unread ? nil : row.updated,
                        unread: row.unread,
                        messages: []
                    )
                )
            }
        }
        cache.sort { $0.updated > $1.updated }
        saveCache(cache)
    }

    private func cachedThread(id: String) -> CachedChat? {
        loadCache().first { $0.sessionId == id }
    }

    private func loadCache() -> [CachedChat] {
        guard let data = defaults.data(forKey: cacheKey) else { return [] }
        return (try? JSONDecoder().decode([CachedChat].self, from: data)) ?? []
    }

    private func saveCache(_ rows: [CachedChat]) {
        guard let data = try? JSONEncoder().encode(rows) else { return }
        defaults.set(data, forKey: cacheKey)
    }

    static func title(from turns: [ChatTurn]) -> String {
        let raw = turns.first(where: { $0.role == "user" })?.content ?? ""
        let text = raw
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "Chat" }
        if text.count <= 72 { return text }
        return String(text.prefix(72))
    }

    static func shouldAdoptSession(current: String?, persisted: String?, saved: String) -> Bool {
        if let current, !current.isEmpty {
            return current == persisted || current == saved
        }
        return persisted == nil || persisted?.isEmpty == true
    }

    private static func lastReadOnPersist(existing: CachedChat?, now: Date) -> String {
        guard let existing else { return ChatISODate.string(from: now) }
        if let kept = existing.lastRead, !kept.isEmpty { return kept }
        if !existing.updated.isEmpty { return existing.updated }
        return ChatISODate.string(from: now)
    }

    static func isUnread(updated: Date, lastRead: String) -> Bool {
        guard !lastRead.isEmpty else { return false }
        return updated > ChatISODate.date(from: lastRead)
    }

    private static func cachedUnread(_ cached: CachedChat) -> Bool {
        if let lastRead = cached.lastRead, !lastRead.isEmpty {
            return isUnread(updated: ChatISODate.date(from: cached.updated), lastRead: lastRead)
        }
        return cached.unread
    }
}

private struct CachedChat: Codable {
    var sessionId: String
    var title: String
    var preview: String
    var started: String
    var updated: String
    var lastRead: String?
    var unread: Bool
    var messages: [ChatMessageBody]
}
