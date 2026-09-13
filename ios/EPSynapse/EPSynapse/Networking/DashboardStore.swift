import Combine
import Foundation
import SwiftUI

@MainActor
final class DashboardStore: ObservableObject {
  static let tags = ["CW", "HW", "QA", "MA"]

  @Published var courses: [Course] = []
  @Published var scheduleClasses: [SchoolClass] = []
  @Published var meetings: [ScheduleMeeting] = []
  @Published var assignments: [Assignment] = []
  @Published var files: [DriveFile] = []
  @Published var classFiles: [DriveFile] = []
  @Published var todoFiles: [DriveFile] = []
  @Published var localFiles: [DriveFile] = []
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
  @Published var uiContext: AgentUIContext = .home()
  @Published var stackDepth = 0

  var displayedClasses: [SchoolClass] {
    if !scheduleClasses.isEmpty { return scheduleClasses }
    return courses.map(SchoolClass.init(course:))
  }

  var noteClassLabels: [String] {
    var seen = Set<String>()
    var names: [String] = []
    for row in displayedClasses where !row.freePeriod {
      let name = row.name.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !name.isEmpty, seen.insert(name).inserted else { continue }
      names.append(name)
    }
    if names.isEmpty { return NoteSubject.all }
    if !names.contains("Other") { names.append("Other") }
    return names
  }

  private let api = APIClient.shared

  init() {
    localFiles = Self.readImportedFiles()
  }

  var allFiles: [DriveFile] {
    localFiles + files
  }

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
      classFiles = []
      todoFiles = []
      messages = []
      filesError = ""
      mailError = ""
      notes = []
      openMail = nil
      notesStatus = ""
      scheduleStatus = ""
      sendStatus = ""
      return
    }

    async let fetchedCourses: [Course] = {
      guard me.canvasConnected else { return [] }
      return await self.loadCourses(sessionId: sid)
    }()
    async let fetchedAssignments: [Assignment] = self.loadAssignments(sessionId: sid)
    async let fetchedClassFiles: [DriveFile] = self.loadClassFiles(sessionId: sid)
    async let fetchedTodoFiles: [DriveFile] = self.loadTodoFiles(sessionId: sid)
    async let fetchedSchedule: (classes: [SchoolClass], meetings: [ScheduleMeeting]) = self.loadSchedule(
      sessionId: sid
    )
    async let fetchedNotes: [ClassifiedNote] = self.loadNotes(sessionId: sid)

    courses = await fetchedCourses
    assignments = await fetchedAssignments
    classFiles = await fetchedClassFiles
    todoFiles = await fetchedTodoFiles
    files = []
    messages = []
    filesError = ""
    mailError = ""
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

  func assignment(id: String) -> Assignment? {
    assignments.first { $0.id == id }
  }

  func assignments(for schoolClass: SchoolClass) -> [Assignment] {
    assignments.filter { Self.assignment($0, matches: schoolClass) }
  }

  func files(for schoolClass: SchoolClass) -> [DriveFile] {
    let owned = classFiles.filter {
      $0.classId == schoolClass.id ||
        (!$0.classId.isEmpty && $0.classId.caseInsensitiveCompare(schoolClass.id) == .orderedSame)
    }
    let pool = allFiles
    let hint = schoolClass.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let matched = hint.isEmpty ? [] : pool.filter { $0.name.lowercased().contains(hint) }
    var seen = Set<String>()
    return (owned + matched).filter { seen.insert($0.id).inserted }
  }

  func files(forTodo item: Assignment) -> [DriveFile] {
    let owned = todoFiles.filter { file in
      !file.todoId.isEmpty && (
        file.todoId == item.id || file.todoId.caseInsensitiveCompare(item.id) == .orderedSame
      )
    }
    let hint = item.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let pool = allFiles + todoFiles
    let matched = hint.isEmpty ? [] : pool.filter { $0.name.lowercased().contains(hint) }
    var seen = Set<String>()
    return (owned + matched).filter { seen.insert($0.id).inserted }
  }

  func refreshTodoFiles(todoId: String, session: SessionStore) async {
    guard !session.sessionId.isEmpty else { return }
    do {
      let wrapped = try await api.listTodoFiles(todoId: todoId, sessionId: session.sessionId)
      mergeTodoFiles(wrapped.files)
    } catch {
      /* cached list is enough if the route is not up yet */
    }
  }

  func importLocalFile(from url: URL) {
    let accessed = url.startAccessingSecurityScopedResource()
    defer {
      if accessed { url.stopAccessingSecurityScopedResource() }
    }
    let original = url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent
    let dest = Self.importedDirectory().appendingPathComponent(Self.uniqueImportedName(original))
    do {
      if FileManager.default.fileExists(atPath: dest.path) {
        try FileManager.default.removeItem(at: dest)
      }
      try FileManager.default.copyItem(at: url, to: dest)
      let file = DriveFile(
        id: dest.lastPathComponent,
        name: dest.lastPathComponent,
        webUrl: dest.absoluteString,
        source: "local"
      )
      localFiles.removeAll { $0.id == file.id }
      localFiles.insert(file, at: 0)
      Self.writeImportedFiles(localFiles)
    } catch {
      filesError = "Could not import that file."
    }
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
      notesStatus = (error as? APIError)?.message ?? "Could not update the class."
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

  func markDone(_ item: Assignment, session: SessionStore) async {
    guard !item.done else { return }
    let id = item.id
    guard let index = assignments.firstIndex(where: { $0.id == id }) else { return }
    withAnimation(.easeInOut(duration: 0.7)) {
      assignments[index].done = true
    }
    let canvasId = item.canvasId.isEmpty ? id : item.canvasId
    do {
      let saved: AssignmentCompleteResponse = try await api.request(
        "/v1/me/canvas/assignments/\(Self.queryValue(id))/complete",
        method: "POST",
        body: CompleteAssignmentBody(
          canvasId: canvasId,
          plannerOverrideId: item.plannerOverrideId,
          plannableType: item.plannableType.isEmpty ? "assignment" : item.plannableType
        ),
        sessionId: session.sessionId,
        timeout: 15
      )
      if let again = assignments.firstIndex(where: { $0.id == id }), !saved.plannerOverrideId.isEmpty {
        assignments[again].plannerOverrideId = saved.plannerOverrideId
      }
    } catch {
      // Local complete still stands so the row can move during the demo.
    }
  }

  func markUndone(_ item: Assignment, session: SessionStore) async {
    guard item.done else { return }
    let id = item.id
    guard let index = assignments.firstIndex(where: { $0.id == id }) else { return }
    withAnimation(.easeInOut(duration: 0.7)) {
      assignments[index].done = false
    }
    let canvasId = item.canvasId.isEmpty ? id : item.canvasId
    do {
      let saved: AssignmentCompleteResponse = try await api.request(
        "/v1/me/canvas/assignments/\(Self.queryValue(id))/incomplete",
        method: "POST",
        body: CompleteAssignmentBody(
          canvasId: canvasId,
          plannerOverrideId: item.plannerOverrideId,
          plannableType: item.plannableType.isEmpty ? "assignment" : item.plannableType
        ),
        sessionId: session.sessionId,
        timeout: 15
      )
      if let again = assignments.firstIndex(where: { $0.id == id }), !saved.plannerOverrideId.isEmpty {
        assignments[again].plannerOverrideId = saved.plannerOverrideId
      }
    } catch {
      // Local incomplete still stands so the row can move during the demo.
    }
  }

  func toggleDone(_ item: Assignment, session: SessionStore) async {
    if item.done {
      await markUndone(item, session: session)
    } else {
      await markDone(item, session: session)
    }
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

  private func loadClassFiles(sessionId: String) async -> [DriveFile] {
    let wrapped: FilesResponse? = try? await api.listClassFiles(classId: "", sessionId: sessionId)
    return wrapped?.files ?? []
  }

  private func loadTodoFiles(sessionId: String) async -> [DriveFile] {
    let wrapped: FilesResponse? = try? await api.listTodoFiles(todoId: "", sessionId: sessionId)
    return wrapped?.files ?? []
  }

  private func mergeTodoFiles(_ incoming: [DriveFile]) {
    var seen = Dictionary(uniqueKeysWithValues: todoFiles.map { ($0.id, $0) })
    for file in incoming {
      seen[file.id] = file
    }
    todoFiles = Array(seen.values)
  }

  func deleteNote(id: String, session: SessionStore) async -> Bool {
    let nid = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !nid.isEmpty, !session.sessionId.isEmpty else { return false }
    do {
      try await api.deleteNote(id: nid, sessionId: session.sessionId)
      notes.removeAll { $0.id == nid }
      return true
    } catch {
      notesStatus = (error as? APIError)?.message ?? "Could not delete that note."
      return false
    }
  }

  private static let importedIndexKey = "epsynapse.imported.files"

  private static func importedDirectory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let dir = base.appendingPathComponent("ImportedFiles", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private static func uniqueImportedName(_ original: String) -> String {
    let dest = importedDirectory().appendingPathComponent(original)
    if !FileManager.default.fileExists(atPath: dest.path) { return original }
    return "\(UUID().uuidString.prefix(8))-\(original)"
  }

  private static func readImportedFiles() -> [DriveFile] {
    guard let data = UserDefaults.standard.data(forKey: importedIndexKey),
          let files = try? JSONDecoder().decode([DriveFile].self, from: data)
    else { return [] }
    return files.filter { file in
      guard let url = URL(string: file.webUrl), url.isFileURL else { return false }
      return FileManager.default.fileExists(atPath: url.path)
    }
  }

  private static func writeImportedFiles(_ files: [DriveFile]) {
    if let data = try? JSONEncoder().encode(files) {
      UserDefaults.standard.set(data, forKey: importedIndexKey)
    }
  }

  private static func queryValue(_ raw: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
  }
}
