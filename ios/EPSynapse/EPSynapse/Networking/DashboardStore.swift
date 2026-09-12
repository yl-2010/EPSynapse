import Combine
import Foundation

@MainActor
final class DashboardStore: ObservableObject {
  static let tags = ["CW", "HW", "QA", "MA"]

  @Published var courses: [Course] = []
  @Published var scheduleClasses: [SchoolClass] = []
  @Published var meetings: [ScheduleMeeting] = []
  @Published var assignments: [Assignment] = []
  @Published var files: [DriveFile] = []
  @Published var messages: [MailMessage] = []
  @Published var filesError = ""
  @Published var mailError = ""
  @Published var notes: [ClassifiedNote] = []
  @Published var openMail: MailMessage?
  @Published var mailBusy = false
  @Published var sendStatus = ""
  @Published var notesBusy = false
  @Published var notesStatus = ""
  @Published var scheduleBusy = false
  @Published var scheduleStatus = ""
  @Published var typeFilter: Set<String> = Set(DashboardStore.tags)
  @Published var isLoading = false

  var displayedClasses: [SchoolClass] {
    if !scheduleClasses.isEmpty { return scheduleClasses }
    return courses.map(SchoolClass.init(course:))
  }

  private let api = APIClient.shared

  func load(from session: SessionStore) async {
    isLoading = true
    defer { isLoading = false }

    let sid = session.sessionId
    let me = session.profile
    guard !sid.isEmpty, let me else {
      courses = []
      scheduleClasses = []
      meetings = []
      assignments = []
      files = []
      messages = []
      filesError = ""
      mailError = ""
      notes = []
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
    async let fetchedFiles: (files: [DriveFile], error: String) = self.loadFiles(sessionId: sid)
    async let fetchedMessages: (messages: [MailMessage], error: String) = self.loadMessages(sessionId: sid)
    async let fetchedSchedule: (classes: [SchoolClass], meetings: [ScheduleMeeting]) = self.loadSchedule(
      sessionId: sid
    )
    async let fetchedNotes: [ClassifiedNote] = self.loadNotes(sessionId: sid)

    courses = await fetchedCourses
    assignments = await fetchedAssignments
    let fileResult = await fetchedFiles
    files = fileResult.files
    filesError = fileResult.error
    let mailResult = await fetchedMessages
    messages = mailResult.messages
    mailError = mailResult.error
    let schedule = await fetchedSchedule
    scheduleClasses = schedule.classes
    meetings = schedule.meetings
    notes = await fetchedNotes
  }

  func schoolClass(id: String) -> SchoolClass? {
    displayedClasses.first { $0.id == id }
  }

  func note(id: String) -> ClassifiedNote? {
    notes.first { $0.id == id }
  }

  func assignments(for schoolClass: SchoolClass) -> [Assignment] {
    assignments.filter { Self.assignment($0, matches: schoolClass) }
  }

  func files(for schoolClass: SchoolClass) -> [DriveFile] {
    let hint = schoolClass.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !hint.isEmpty else { return files }
    let matched = files.filter { $0.name.lowercased().contains(hint) }
    return matched.isEmpty ? files : matched
  }

  func notes(for schoolClass: SchoolClass) -> [ClassifiedNote] {
    notes.filter { note in
      if !note.classId.isEmpty, note.classId == schoolClass.id { return true }
      if Self.namesOverlap(note.subject, schoolClass.name) { return true }
      return Self.namesOverlap(note.subject, schoolClass.subject)
    }
  }

  func meetings(for schoolClass: SchoolClass) -> [ScheduleMeeting] {
    meetings.filter { meeting in
      if !meeting.classId.isEmpty, meeting.classId == schoolClass.id { return true }
      if !meeting.period.isEmpty, meeting.period == schoolClass.period { return true }
      return false
    }
  }

  func uploadSchedule(fileURL: URL, session: SessionStore) async {
    guard !session.sessionId.isEmpty else {
      scheduleStatus = SessionStore.googleFirst
      return
    }
    if scheduleBusy { return }
    scheduleBusy = true
    scheduleStatus = "Uploading schedule…"
    defer { scheduleBusy = false }
    do {
      let wrapped = try await api.uploadSchedulePDF(fileURL: fileURL, sessionId: session.sessionId)
      scheduleClasses = wrapped.classes
      meetings = wrapped.meetings
      let count = wrapped.classes.count
      scheduleStatus = count == 1 ? "Schedule uploaded · 1 class" : "Schedule uploaded · \(count) classes"
      await load(from: session)
    } catch {
      scheduleStatus = (error as? APIError)?.message ?? "Could not upload the schedule PDF."
    }
  }

  func classifyNote(text: String, session: SessionStore) async -> ClassifiedNote? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !session.sessionId.isEmpty else {
      notesStatus = SessionStore.googleFirst
      return nil
    }
    if trimmed.isEmpty {
      notesStatus = "Paste a note first."
      return nil
    }
    if notesBusy { return nil }
    notesBusy = true
    notesStatus = "Classifying…"
    defer { notesBusy = false }
    do {
      let wrapped = try await api.createNote(text: trimmed, sessionId: session.sessionId)
      let note = wrapped.note
      if note.id.isEmpty {
        notesStatus = "Could not classify that note."
        return nil
      }
      if let index = notes.firstIndex(where: { $0.id == note.id }) {
        notes[index] = note
      } else {
        notes.insert(note, at: 0)
      }
      notesStatus = note.subject.isEmpty ? "Classified." : "Classified · \(note.subject)"
      return note
    } catch {
      notesStatus = (error as? APIError)?.message ?? "Could not classify that note."
      return nil
    }
  }

  func refreshNote(id: String, session: SessionStore) async {
    let nid = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !nid.isEmpty, !session.sessionId.isEmpty else { return }
    do {
      let wrapped = try await api.fetchNote(id: nid, sessionId: session.sessionId)
      let note = wrapped.note
      guard !note.id.isEmpty else { return }
      if let index = notes.firstIndex(where: { $0.id == note.id }) {
        notes[index] = note
      } else {
        notes.insert(note, at: 0)
      }
    } catch {
      /* list preview is enough if the detail route is down */
    }
  }

  func updateNoteSubject(id: String, subject: String, session: SessionStore) async {
    let nid = id.trimmingCharacters(in: .whitespacesAndNewlines)
    let next = subject.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !nid.isEmpty, !next.isEmpty, !session.sessionId.isEmpty else { return }
    if let current = note(id: nid), current.subject == next { return }
    do {
      let wrapped = try await api.patchNote(id: nid, subject: next, sessionId: session.sessionId)
      let note = wrapped.note
      if let index = notes.firstIndex(where: { $0.id == nid }) {
        if note.id.isEmpty {
          notes[index].subject = next
        } else {
          notes[index] = note
        }
      } else if !note.id.isEmpty {
        notes.insert(note, at: 0)
      }
    } catch {
      notesStatus = (error as? APIError)?.message ?? "Could not update the subject."
    }
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

  private func loadSchedule(sessionId: String) async -> (classes: [SchoolClass], meetings: [ScheduleMeeting]) {
    do {
      let wrapped = try await api.fetchSchedule(sessionId: sessionId)
      return (wrapped.classes, wrapped.meetings)
    } catch {
      return ([], [])
    }
  }

  private func loadNotes(sessionId: String) async -> [ClassifiedNote] {
    do {
      let wrapped = try await api.listNotes(sessionId: sessionId)
      return wrapped.notes
    } catch {
      return []
    }
  }

  private static func assignment(_ item: Assignment, matches schoolClass: SchoolClass) -> Bool {
    if !item.courseId.isEmpty, item.courseId == schoolClass.id { return true }
    return namesOverlap(item.courseName, schoolClass.name)
  }

  private static func namesOverlap(_ a: String, _ b: String) -> Bool {
    let left = a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let right = b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if left.isEmpty || right.isEmpty { return false }
    if left == right { return true }
    return left.contains(right) || right.contains(left)
  }

  private func loadCourses(sessionId: String) async -> [Course] {
    let wrapped: CoursesResponse? = try? await api.request("/v1/me/canvas/courses", sessionId: sessionId)
    return wrapped?.courses ?? []
  }

  private func loadAssignments(sessionId: String) async -> [Assignment] {
    let wrapped: AssignmentsResponse? = try? await api.request("/v1/me/canvas/assignments", sessionId: sessionId)
    return wrapped?.assignments ?? []
  }

  private func loadFiles(sessionId: String) async -> (files: [DriveFile], error: String) {
    do {
      let wrapped: FilesResponse = try await api.request("/v1/me/onedrive/files", sessionId: sessionId, timeout: 20)
      return (wrapped.files, wrapped.error)
    } catch {
      return ([], (error as? APIError)?.message ?? "Could not load files.")
    }
  }

  private func loadMessages(sessionId: String) async -> (messages: [MailMessage], error: String) {
    do {
      let wrapped: MessagesResponse = try await api.request(
        "/v1/me/outlook/messages?limit=12",
        sessionId: sessionId,
        timeout: 20
      )
      return (wrapped.messages, wrapped.error)
    } catch {
      return ([], (error as? APIError)?.message ?? "Could not load mail.")
    }
  }

  private static func queryValue(_ raw: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
  }
}
