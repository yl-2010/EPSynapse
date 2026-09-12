import Combine
import Foundation

@MainActor
final class DashboardStore: ObservableObject {
  static let tags = ["CW", "HW", "QA", "MA"]

  @Published var courses: [Course] = []
  @Published var assignments: [Assignment] = []
  @Published var files: [DriveFile] = []
  @Published var messages: [MailMessage] = []
  @Published var openMail: MailMessage?
  @Published var mailBusy = false
  @Published var sendStatus = ""
  @Published var typeFilter: Set<String> = Set(DashboardStore.tags)
  @Published var isLoading = false

  private let api = APIClient.shared

  func load(from session: SessionStore) async {
    isLoading = true
    defer { isLoading = false }

    let sid = session.sessionId
    let me = session.profile
    guard !sid.isEmpty, let me else {
      courses = []
      assignments = []
      files = []
      messages = []
      return
    }

    async let fetchedCourses: [Course] = {
      guard me.canvasConnected else { return [] }
      return await self.loadCourses(sessionId: sid)
    }()
    async let fetchedAssignments: [Assignment] = {
      guard me.canvasConnected else { return [] }
      return await self.loadAssignments(sessionId: sid)
    }()
    async let fetchedFiles: [DriveFile] = {
      guard me.onedriveConnected else { return [] }
      return await self.loadFiles(sessionId: sid)
    }()
    async let fetchedMessages: [MailMessage] = {
      guard me.outlookConnected else { return [] }
      return await self.loadMessages(sessionId: sid)
    }()

    courses = await fetchedCourses
    assignments = await fetchedAssignments
    files = await fetchedFiles
    messages = await fetchedMessages
  }

  func toggleFilter(_ tag: String) {
    var next = typeFilter
    if next.contains(tag) {
      next.remove(tag)
    } else {
      next.insert(tag)
    }
    if next.isEmpty {
      next = Set(Self.tags)
    }
    typeFilter = next
  }

  func openMessage(id: String, session: SessionStore) async {
    let mid = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !mid.isEmpty, !session.sessionId.isEmpty else { return }
    do {
      let path = "/v1/me/outlook/message?id=\(Self.queryValue(mid))"
      let wrapped: MessageResponse = try await api.request(path, sessionId: session.sessionId, timeout: 20)
      openMail = wrapped.message
    } catch {
      let message = (error as? APIError)?.message ?? "Read failed."
      openMail = MailMessage(subject: "Could not open", body: message)
    }
  }

  func sendMail(to: String, subject: String, body: String, session: SessionStore) async {
    let trimmedTo = to.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedSubject = subject.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedTo.isEmpty || trimmedSubject.isEmpty || trimmedBody.isEmpty {
      sendStatus = "To, subject, and body are required."
      return
    }
    if mailBusy { return }
    mailBusy = true
    sendStatus = ""
    defer { mailBusy = false }
    do {
      let sent: SendMailResponse = try await api.request(
        "/v1/me/outlook/send",
        method: "POST",
        body: SendMailBody(to: trimmedTo, subject: trimmedSubject, body: trimmedBody),
        sessionId: session.sessionId,
        timeout: 25
      )
      openMail = nil
      sendStatus = sent.sent ? "Sent to \(sent.to)" : "Sent."
    } catch {
      sendStatus = (error as? APIError)?.message ?? "Send failed."
    }
  }

  static func currentPeriod(now: Date = Date(), calendar: Calendar = .current) -> (num: String, letter: String)? {
    let weekday = calendar.component(.weekday, from: now)
    if weekday == 1 || weekday == 7 { return nil }
    let minutes = calendar.component(.hour, from: now) * 60 + calendar.component(.minute, from: now)
    let bells: [(Int, Int, String, String)] = [
      (8 * 60, 8 * 60 + 50, "1", "A"),
      (8 * 60 + 55, 9 * 60 + 45, "2", "B"),
      (9 * 60 + 50, 10 * 60 + 40, "3", "C"),
      (10 * 60 + 45, 11 * 60 + 35, "4", "D"),
      (12 * 60 + 15, 13 * 60 + 5, "5", "E"),
      (13 * 60 + 10, 14 * 60, "6", "F"),
      (14 * 60 + 5, 14 * 60 + 55, "7", "G"),
      (15 * 60, 15 * 60 + 50, "8", "H"),
    ]
    guard let hit = bells.first(where: { minutes >= $0.0 && minutes < $0.1 }) else { return nil }
    return (hit.2, hit.3)
  }

  private func loadCourses(sessionId: String) async -> [Course] {
    let wrapped: CoursesResponse? = try? await api.request("/v1/me/canvas/courses", sessionId: sessionId)
    return wrapped?.courses ?? []
  }

  private func loadAssignments(sessionId: String) async -> [Assignment] {
    let wrapped: AssignmentsResponse? = try? await api.request("/v1/me/canvas/assignments", sessionId: sessionId)
    return wrapped?.assignments ?? []
  }

  private func loadFiles(sessionId: String) async -> [DriveFile] {
    let wrapped: FilesResponse? = try? await api.request("/v1/me/onedrive/files", sessionId: sessionId, timeout: 20)
    return wrapped?.files ?? []
  }

  private func loadMessages(sessionId: String) async -> [MailMessage] {
    let wrapped: MessagesResponse? = try? await api.request(
      "/v1/me/outlook/messages?limit=12",
      sessionId: sessionId,
      timeout: 20
    )
    return wrapped?.messages ?? []
  }

  private static func queryValue(_ raw: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
  }
}
