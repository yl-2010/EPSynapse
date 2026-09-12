import Foundation

private extension KeyedDecodingContainer {
  func string(_ key: Key) -> String {
    if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
    if let value = try? decodeIfPresent(Int.self, forKey: key) { return String(value) }
    if let value = try? decodeIfPresent(Double.self, forKey: key) { return String(Int(value)) }
    return ""
  }

  func bool(_ key: Key) -> Bool {
    (try? decodeIfPresent(Bool.self, forKey: key)) ?? false
  }

  func int(_ key: Key) -> Int {
    if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
    if let value = try? decodeIfPresent(Double.self, forKey: key) { return Int(value) }
    if let raw = try? decodeIfPresent(String.self, forKey: key), let value = Int(raw) {
      return value
    }
    return 0
  }

  func strings(_ key: Key) -> [String] {
    (try? decodeIfPresent([String].self, forKey: key)) ?? []
  }
}

struct Profile: Codable, Equatable {
  var school: String
  var studentId: String
  var canvasHost: String
  var displayName: String
  var email: String
  var googleName: String
  var picture: String
  var rosterName: String
  var rosterMatched: Bool
  var canvasConnected: Bool
  var onedriveConnected: Bool
  var outlookConnected: Bool
  var teamsConnected: Bool
  var onedriveEmail: String
  var outlookEmail: String
  var teamsEmail: String
  var onedrivePending: DevicePending?
  var outlookPending: DevicePending?
  var teamsPending: DevicePending?
  var modelKeySet: Bool
  var modelProvider: String
  var modelKeyHint: String
  var modelKeyHints: [String]
  var modelKeyCount: Int
  var sessionId: String?

  init(
    school: String = "",
    studentId: String = "",
    canvasHost: String = "",
    displayName: String = "",
    email: String = "",
    googleName: String = "",
    picture: String = "",
    rosterName: String = "",
    rosterMatched: Bool = false,
    canvasConnected: Bool = false,
    onedriveConnected: Bool = false,
    outlookConnected: Bool = false,
    teamsConnected: Bool = false,
    onedriveEmail: String = "",
    outlookEmail: String = "",
    teamsEmail: String = "",
    onedrivePending: DevicePending? = nil,
    outlookPending: DevicePending? = nil,
    teamsPending: DevicePending? = nil,
    modelKeySet: Bool = false,
    modelProvider: String = "groq",
    modelKeyHint: String = "",
    modelKeyHints: [String] = [],
    modelKeyCount: Int = 0,
    sessionId: String? = nil
  ) {
    self.school = school
    self.studentId = studentId
    self.canvasHost = canvasHost
    self.displayName = displayName
    self.email = email
    self.googleName = googleName
    self.picture = picture
    self.rosterName = rosterName
    self.rosterMatched = rosterMatched
    self.canvasConnected = canvasConnected
    self.onedriveConnected = onedriveConnected
    self.outlookConnected = outlookConnected
    self.teamsConnected = teamsConnected
    self.onedriveEmail = onedriveEmail
    self.outlookEmail = outlookEmail
    self.teamsEmail = teamsEmail
    self.onedrivePending = onedrivePending
    self.outlookPending = outlookPending
    self.teamsPending = teamsPending
    self.modelKeySet = modelKeySet
    self.modelProvider = modelProvider
    self.modelKeyHint = modelKeyHint
    self.modelKeyHints = modelKeyHints
    self.modelKeyCount = modelKeyCount
    self.sessionId = sessionId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    school = c.string(.school)
    studentId = c.string(.studentId)
    canvasHost = c.string(.canvasHost)
    displayName = c.string(.displayName)
    email = c.string(.email)
    googleName = c.string(.googleName)
    picture = c.string(.picture)
    rosterName = c.string(.rosterName)
    rosterMatched = c.bool(.rosterMatched)
    canvasConnected = c.bool(.canvasConnected)
    onedriveConnected = c.bool(.onedriveConnected)
    outlookConnected = c.bool(.outlookConnected)
    teamsConnected = c.bool(.teamsConnected)
    onedriveEmail = c.string(.onedriveEmail)
    outlookEmail = c.string(.outlookEmail)
    teamsEmail = c.string(.teamsEmail)
    onedrivePending = try c.decodeIfPresent(DevicePending.self, forKey: .onedrivePending)
    outlookPending = try c.decodeIfPresent(DevicePending.self, forKey: .outlookPending)
    teamsPending = try c.decodeIfPresent(DevicePending.self, forKey: .teamsPending)
    modelKeySet = c.bool(.modelKeySet)
    modelProvider = c.string(.modelProvider)
    if modelProvider.isEmpty { modelProvider = "groq" }
    modelKeyHint = c.string(.modelKeyHint)
    modelKeyHints = c.strings(.modelKeyHints)
    modelKeyCount = c.int(.modelKeyCount)
    if modelKeyCount == 0, !modelKeyHints.isEmpty {
      modelKeyCount = modelKeyHints.count
    } else if modelKeySet, modelKeyCount == 0, modelKeyHints.isEmpty {
      modelKeyCount = 1
    }
    let sid = c.string(.sessionId)
    sessionId = sid.isEmpty ? nil : sid
  }

  var signedInName: String {
    if !googleName.isEmpty { return googleName }
    if !displayName.isEmpty { return displayName }
    if !rosterName.isEmpty { return rosterName }
    return email
  }
}

struct DevicePending: Codable, Equatable {
  var user_code: String
  var verification_uri: String
  var verification_uri_complete: String
  var message: String

  var openURL: String {
    if !verification_uri_complete.isEmpty { return verification_uri_complete }
    if user_code.isEmpty { return verification_uri }
    return "https://login.microsoft.com/device?otc=\(user_code)"
  }

  init(
    user_code: String = "",
    verification_uri: String = "",
    verification_uri_complete: String = "",
    message: String = ""
  ) {
    self.user_code = user_code
    self.verification_uri = verification_uri
    self.verification_uri_complete = verification_uri_complete
    self.message = message
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    user_code = c.string(.user_code)
    verification_uri = c.string(.verification_uri)
    verification_uri_complete = c.string(.verification_uri_complete)
    message = c.string(.message)
  }

  var isActive: Bool {
    !user_code.isEmpty || !verification_uri.isEmpty
  }
}

struct Course: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var courseCode: String
  var period: String

  init(id: String = "", name: String = "", courseCode: String = "", period: String = "") {
    self.id = id
    self.name = name
    self.courseCode = courseCode
    self.period = period
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    name = c.string(.name)
    courseCode = c.string(.courseCode)
    period = c.string(.period)
  }
}

struct Assignment: Codable, Identifiable, Equatable {
  var id: String
  var canvasId: String
  var canvasLink: String
  var title: String
  var courseName: String
  var courseId: String
  var due: String
  var tag: String
  var done: Bool
  var plannerOverrideId: String
  var plannableType: String
  var description: String
  var classId: String

  init(
    id: String = "",
    canvasId: String = "",
    canvasLink: String = "",
    title: String = "",
    courseName: String = "",
    courseId: String = "",
    due: String = "",
    tag: String = "",
    done: Bool = false,
    plannerOverrideId: String = "",
    plannableType: String = "assignment",
    description: String = "",
    classId: String = ""
  ) {
    self.id = id
    self.canvasId = canvasId
    self.canvasLink = canvasLink
    self.title = title
    self.courseName = courseName
    self.courseId = courseId
    self.due = due
    self.tag = tag
    self.done = done
    self.plannerOverrideId = plannerOverrideId
    self.plannableType = plannableType
    self.description = description
    self.classId = classId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    canvasId = c.string(.canvasId)
    canvasLink = c.string(.canvasLink)
    title = c.string(.title)
    courseName = c.string(.courseName)
    courseId = c.string(.courseId)
    due = c.string(.due)
    tag = c.string(.tag)
    done = c.bool(.done)
    plannerOverrideId = c.string(.plannerOverrideId)
    plannableType = {
      let value = c.string(.plannableType)
      return value.isEmpty ? "assignment" : value
    }()
    description = c.string(.description)
    let decodedClass = c.string(.classId)
    classId = decodedClass.isEmpty ? courseId : decodedClass
  }
}

struct DriveFile: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var webUrl: String
  var source: String
  var classId: String
  var todoId: String
  var contentType: String
  var text: String

  init(
    id: String = "",
    name: String = "",
    webUrl: String = "",
    source: String = "",
    classId: String = "",
    todoId: String = "",
    contentType: String = "",
    text: String = ""
  ) {
    self.id = id
    self.name = name
    self.webUrl = webUrl
    self.source = source
    self.classId = classId
    self.todoId = todoId
    self.contentType = contentType
    self.text = text
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    name = c.string(.name)
    webUrl = c.string(.webUrl)
    source = c.string(.source)
    classId = c.string(.classId)
    todoId = c.string(.todoId)
    contentType = c.string(.contentType)
    text = c.string(.text)
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(webUrl, forKey: .webUrl)
    try c.encode(source, forKey: .source)
    try c.encode(classId, forKey: .classId)
    try c.encode(todoId, forKey: .todoId)
    try c.encode(contentType, forKey: .contentType)
    try c.encode(text, forKey: .text)
  }

  var isHTML: Bool {
    name.lowercased().hasSuffix(".html") || name.lowercased().hasSuffix(".htm") || contentType.contains("html")
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, webUrl, source, classId, todoId, contentType, text
  }
}

struct MailMessage: Codable, Identifiable, Equatable {
  var id: String
  var subject: String
  var from: String
  var fromAddress: String
  var preview: String
  var body: String
  var received: String
  var unread: Bool
  var webLink: String

  init(
    id: String = "",
    subject: String = "",
    from: String = "",
    fromAddress: String = "",
    preview: String = "",
    body: String = "",
    received: String = "",
    unread: Bool = false,
    webLink: String = ""
  ) {
    self.id = id
    self.subject = subject
    self.from = from
    self.fromAddress = fromAddress
    self.preview = preview
    self.body = body
    self.received = received
    self.unread = unread
    self.webLink = webLink
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    subject = c.string(.subject)
    from = c.string(.from)
    fromAddress = c.string(.fromAddress)
    preview = c.string(.preview)
    body = c.string(.body)
    received = c.string(.received)
    unread = c.bool(.unread)
    webLink = c.string(.webLink)
  }
}

struct AgentProvider: Codable, Identifiable, Equatable {
  var id: String
  var label: String
  var model: String
  var signup: String
  var signupLabel: String
  var blurb: String
  var recommended: Bool

  init(
    id: String = "",
    label: String = "",
    model: String = "",
    signup: String = "",
    signupLabel: String = "",
    blurb: String = "",
    recommended: Bool = false
  ) {
    self.id = id
    self.label = label
    self.model = model
    self.signup = signup
    self.signupLabel = signupLabel
    self.blurb = blurb
    self.recommended = recommended
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    label = c.string(.label)
    model = c.string(.model)
    signup = c.string(.signup)
    signupLabel = c.string(.signupLabel)
    blurb = c.string(.blurb)
    recommended = c.bool(.recommended)
  }
}

struct ChatTurn: Identifiable, Equatable {
  var id: UUID
  var role: String
  var content: String
  var thinking: String

  init(id: UUID = UUID(), role: String, content: String, thinking: String = "") {
    self.id = id
    self.role = role
    self.content = content
    self.thinking = thinking
  }
}

struct EmptyJSON: Encodable {}

struct SaveAgentBody: Encodable {
  var provider: String?
  var modelKey: String?
  var clear: Bool?
  var removeIndex: Int?

  enum CodingKeys: String, CodingKey {
    case provider, modelKey, clear, removeIndex
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if let provider, !provider.isEmpty {
      try c.encode(provider, forKey: .provider)
    }
    if let modelKey, !modelKey.isEmpty {
      try c.encode(modelKey, forKey: .modelKey)
    }
    if clear == true {
      try c.encode(true, forKey: .clear)
    }
    if let removeIndex {
      try c.encode(removeIndex, forKey: .removeIndex)
    }
  }
}

struct SaveMeBody: Encodable {
  var school: String
  var studentId: String
  var canvasHost: String
  var canvasToken: String?

  enum CodingKeys: String, CodingKey {
    case school, studentId, canvasHost, canvasToken
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(school, forKey: .school)
    try c.encode(studentId, forKey: .studentId)
    try c.encode(canvasHost, forKey: .canvasHost)
    if let canvasToken, !canvasToken.isEmpty {
      try c.encode(canvasToken, forKey: .canvasToken)
    }
  }
}

struct SendMailBody: Encodable {
  var to: String
  var subject: String
  var body: String
}

struct CompleteAssignmentBody: Encodable {
  var canvasId: String
  var plannerOverrideId: String
  var plannableType: String
}

struct AgentUIContext: Codable, Equatable {
  var client: String
  var view: String
  var path: String
  var classId: String
  var className: String
  var period: String
  var noteId: String
  var noteTitle: String
  var noteSubject: String
  var noteText: String
  var todoId: String
  var todoTitle: String

  init(
    client: String = "ios",
    view: String = "home",
    path: String = "",
    classId: String = "",
    className: String = "",
    period: String = "",
    noteId: String = "",
    noteTitle: String = "",
    noteSubject: String = "",
    noteText: String = "",
    todoId: String = "",
    todoTitle: String = ""
  ) {
    self.client = client
    self.view = view
    self.path = path
    self.classId = classId
    self.className = className
    self.period = period
    self.noteId = noteId
    self.noteTitle = noteTitle
    self.noteSubject = noteSubject
    self.noteText = noteText
    self.todoId = todoId
    self.todoTitle = todoTitle
  }

  static func home() -> AgentUIContext {
    AgentUIContext(view: "home", path: "/")
  }

  static func schoolClass(_ row: SchoolClass) -> AgentUIContext {
    AgentUIContext(
      view: "class",
      path: "/class/\(row.id)",
      classId: row.id,
      className: row.name,
      period: row.period
    )
  }

  static func note(_ row: ClassifiedNote) -> AgentUIContext {
    let title = row.text
      .split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .first(where: { !$0.isEmpty })
      .map { String($0) } ?? ""
    return AgentUIContext(
      view: "note",
      path: "/note/\(row.id)",
      classId: row.classId,
      noteId: row.id,
      noteTitle: String(title.prefix(200)),
      noteSubject: row.subject,
      noteText: String(row.text.prefix(1500))
    )
  }

  static func todo(_ item: Assignment) -> AgentUIContext {
    AgentUIContext(
      view: "todo",
      path: "/todo/\(item.id)",
      classId: item.classId.isEmpty ? item.courseId : item.classId,
      className: item.courseName,
      todoId: item.id,
      todoTitle: item.title
    )
  }
}

struct ChatRequestBody: Encodable {
  var provider: String
  var messages: [[String: String]]
  var uiContext: AgentUIContext?
}

struct ChatMessageBody: Codable, Equatable {
  var role: String
  var content: String

  init(role: String, content: String) {
    self.role = role
    self.content = content
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    role = c.string(.role)
    content = c.string(.content)
  }
}

struct ChatListItemResponse: Codable, Equatable {
  var sessionId: String
  var title: String
  var preview: String
  var started: String
  var updated: String
  var unread: Bool

  init(
    sessionId: String = "",
    title: String = "",
    preview: String = "",
    started: String = "",
    updated: String = "",
    unread: Bool = false
  ) {
    self.sessionId = sessionId
    self.title = title
    self.preview = preview
    self.started = started
    self.updated = updated
    self.unread = unread
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sessionId = c.string(.sessionId)
    title = c.string(.title)
    preview = c.string(.preview)
    started = c.string(.started)
    updated = c.string(.updated)
    unread = c.bool(.unread)
  }
}

struct ChatListResponse: Codable {
  var chats: [ChatListItemResponse]

  init(chats: [ChatListItemResponse] = []) {
    self.chats = chats
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    chats = (try? c.decodeIfPresent([ChatListItemResponse].self, forKey: .chats)) ?? []
  }
}

struct ChatPersistBody: Encodable {
  var sessionId: String?
  var messages: [ChatMessageBody]
  var title: String?

  enum CodingKeys: String, CodingKey {
    case sessionId, messages, title
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if let sessionId, !sessionId.isEmpty {
      try c.encode(sessionId, forKey: .sessionId)
    }
    try c.encode(messages, forKey: .messages)
    if let title, !title.isEmpty {
      try c.encode(title, forKey: .title)
    }
  }
}

struct ChatDetailResponse: Codable {
  var sessionId: String
  var title: String
  var preview: String
  var started: String
  var updated: String
  var unread: Bool
  var messages: [ChatMessageBody]

  init(
    sessionId: String = "",
    title: String = "",
    preview: String = "",
    started: String = "",
    updated: String = "",
    unread: Bool = false,
    messages: [ChatMessageBody] = []
  ) {
    self.sessionId = sessionId
    self.title = title
    self.preview = preview
    self.started = started
    self.updated = updated
    self.unread = unread
    self.messages = messages
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sessionId = c.string(.sessionId)
    title = c.string(.title)
    preview = c.string(.preview)
    started = c.string(.started)
    updated = c.string(.updated)
    unread = c.bool(.unread)
    messages = (try? c.decodeIfPresent([ChatMessageBody].self, forKey: .messages)) ?? []
  }
}

struct CoursesResponse: Codable {
  var courses: [Course]

  init(courses: [Course] = []) {
    self.courses = courses
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    courses = (try? c.decodeIfPresent([Course].self, forKey: .courses)) ?? []
  }
}

struct AssignmentsResponse: Codable {
  var assignments: [Assignment]

  init(assignments: [Assignment] = []) {
    self.assignments = assignments
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    assignments = (try? c.decodeIfPresent([Assignment].self, forKey: .assignments)) ?? []
  }
}

struct AssignmentCompleteResponse: Codable {
  var id: String
  var canvasId: String
  var done: Bool
  var plannerOverrideId: String
  var plannableType: String

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    canvasId = c.string(.canvasId)
    done = c.bool(.done)
    plannerOverrideId = c.string(.plannerOverrideId)
    plannableType = c.string(.plannableType)
  }
}

struct FilesResponse: Codable {
  var files: [DriveFile]
  var error: String

  init(files: [DriveFile] = [], error: String = "") {
    self.files = files
    self.error = error
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    files = (try? c.decodeIfPresent([DriveFile].self, forKey: .files)) ?? []
    error = c.string(.error)
  }
}

struct MessagesResponse: Codable {
  var messages: [MailMessage]
  var error: String

  init(messages: [MailMessage] = [], error: String = "") {
    self.messages = messages
    self.error = error
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    messages = (try? c.decodeIfPresent([MailMessage].self, forKey: .messages)) ?? []
    error = c.string(.error)
  }
}

struct MessageResponse: Codable {
  var message: MailMessage

  init(message: MailMessage = MailMessage()) {
    self.message = message
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    message = (try? c.decodeIfPresent(MailMessage.self, forKey: .message)) ?? MailMessage()
  }
}

struct AgentConfigResponse: Codable {
  var providers: [AgentProvider]

  init(providers: [AgentProvider] = []) {
    self.providers = providers
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    providers = (try? c.decodeIfPresent([AgentProvider].self, forKey: .providers)) ?? []
  }
}

struct DeviceStartResponse: Codable {
  var user_code: String
  var verification_uri: String
  var verification_uri_complete: String
  var message: String
  var interval: Int

  var openURL: String {
    if !verification_uri_complete.isEmpty { return verification_uri_complete }
    if user_code.isEmpty { return verification_uri }
    return "https://login.microsoft.com/device?otc=\(user_code)"
  }

  init(
    user_code: String = "",
    verification_uri: String = "",
    verification_uri_complete: String = "",
    message: String = "",
    interval: Int = 0
  ) {
    self.user_code = user_code
    self.verification_uri = verification_uri
    self.verification_uri_complete = verification_uri_complete
    self.message = message
    self.interval = interval
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    user_code = c.string(.user_code)
    verification_uri = c.string(.verification_uri)
    verification_uri_complete = c.string(.verification_uri_complete)
    message = c.string(.message)
    interval = c.int(.interval)
  }
}

struct ConnectionStatusResponse: Codable {
  var connected: Bool
  var pending: DevicePending?
  var email: String
  var error: String
  var onedriveConnected: Bool
  var outlookConnected: Bool
  var onedriveEmail: String
  var outlookEmail: String

  init(
    connected: Bool = false,
    pending: DevicePending? = nil,
    email: String = "",
    error: String = "",
    onedriveConnected: Bool = false,
    outlookConnected: Bool = false,
    onedriveEmail: String = "",
    outlookEmail: String = ""
  ) {
    self.connected = connected
    self.pending = pending
    self.email = email
    self.error = error
    self.onedriveConnected = onedriveConnected
    self.outlookConnected = outlookConnected
    self.onedriveEmail = onedriveEmail
    self.outlookEmail = outlookEmail
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    connected = c.bool(.connected)
    pending = try c.decodeIfPresent(DevicePending.self, forKey: .pending)
    email = c.string(.email)
    error = c.string(.error)
    onedriveConnected = c.bool(.onedriveConnected)
    outlookConnected = c.bool(.outlookConnected)
    onedriveEmail = c.string(.onedriveEmail)
    outlookEmail = c.string(.outlookEmail)
  }
}

struct LogoutResponse: Codable {
  var ok: Bool

  init(ok: Bool = false) {
    self.ok = ok
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ok = c.bool(.ok)
  }
}

struct SendMailResponse: Codable {
  var sent: Bool
  var to: String
  var subject: String

  init(sent: Bool = false, to: String = "", subject: String = "") {
    self.sent = sent
    self.to = to
    self.subject = subject
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sent = c.bool(.sent)
    to = c.string(.to)
    subject = c.string(.subject)
  }
}

struct GoogleAuthConfig: Codable {
  var clientId: String
  var iosClientId: String

  init(clientId: String = "", iosClientId: String = "") {
    self.clientId = clientId
    self.iosClientId = iosClientId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    clientId = c.string(.clientId)
    iosClientId = c.string(.iosClientId)
  }
}

struct GoogleAuthBody: Encodable {
  var idToken: String
}

struct SchoolHit: Codable, Identifiable, Equatable {
  var slug: String
  var name: String
  var shortName: String
  var domain: String
  var canvasHost: String
  var hasRoster: Bool
  var rosterCount: Int

  var id: String { slug.isEmpty ? name : slug }

  init(
    slug: String = "",
    name: String = "",
    shortName: String = "",
    domain: String = "",
    canvasHost: String = "",
    hasRoster: Bool = false,
    rosterCount: Int = 0
  ) {
    self.slug = slug
    self.name = name
    self.shortName = shortName
    self.domain = domain
    self.canvasHost = canvasHost
    self.hasRoster = hasRoster
    self.rosterCount = rosterCount
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    slug = c.string(.slug)
    name = c.string(.name)
    shortName = c.string(.shortName)
    domain = c.string(.domain)
    canvasHost = c.string(.canvasHost)
    hasRoster = c.bool(.hasRoster)
    rosterCount = c.int(.rosterCount)
  }
}

struct SchoolsResponse: Codable {
  var schools: [SchoolHit]

  init(schools: [SchoolHit] = []) {
    self.schools = schools
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    schools = (try? c.decodeIfPresent([SchoolHit].self, forKey: .schools)) ?? []
  }
}

enum NoteSubject {
  static let all = [
    "Mathematics",
    "Physics",
    "Chemistry",
    "Biology",
    "Computer Science",
    "History",
    "Literature",
    "Economics",
    "Other",
  ]
}

enum EPSLinks {
  static let research = URL(string: "https://epsynapse.com/research")!
  static let onedriveWeb = URL(string: "https://eastsideprep-my.sharepoint.com/")!
  static let outlookWeb = URL(string: "https://outlook.office.com/mail/")!
}

struct SchoolClass: Codable, Identifiable, Hashable, Equatable {
  var id: String
  var name: String
  var period: String
  var trimester: String
  var freePeriod: Bool
  var canvasLink: String
  var courseCode: String
  var subject: String

  init(
    id: String = "",
    name: String = "",
    period: String = "",
    trimester: String = "",
    freePeriod: Bool = false,
    canvasLink: String = "",
    courseCode: String = "",
    subject: String = ""
  ) {
    self.id = id
    self.name = name
    self.period = period
    self.trimester = trimester
    self.freePeriod = freePeriod
    self.canvasLink = canvasLink
    self.courseCode = courseCode
    self.subject = subject
  }

  init(course: Course) {
    let fallback = course.id.isEmpty ? course.name : course.id
    self.init(
      id: fallback,
      name: course.name,
      period: course.period,
      trimester: "",
      freePeriod: false,
      canvasLink: "",
      courseCode: course.courseCode
    )
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let rawId = c.string(.id)
    name = c.string(.name)
    period = c.string(.period)
    let tri = c.string(.trimester)
    trimester = tri.isEmpty ? c.string(.term) : tri
    freePeriod = c.bool(.freePeriod)
    canvasLink = c.string(.canvasLink)
    courseCode = c.string(.courseCode)
    subject = c.string(.subject)
    id = rawId.isEmpty ? name : rawId
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(period, forKey: .period)
    try c.encode(trimester, forKey: .trimester)
    try c.encode(freePeriod, forKey: .freePeriod)
    try c.encode(canvasLink, forKey: .canvasLink)
    try c.encode(courseCode, forKey: .courseCode)
    try c.encode(subject, forKey: .subject)
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, period, trimester, term, freePeriod, canvasLink, courseCode, subject
  }
}

struct ScheduleMeeting: Codable, Identifiable, Equatable {
  var id: String
  var title: String
  var day: String
  var start: String
  var end: String
  var period: String
  var classId: String

  init(
    id: String = "",
    title: String = "",
    day: String = "",
    start: String = "",
    end: String = "",
    period: String = "",
    classId: String = ""
  ) {
    self.id = id
    self.title = title
    self.day = day
    self.start = start
    self.end = end
    self.period = period
    self.classId = classId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let rawId = c.string(.id)
    title = {
      let named = c.string(.title)
      return named.isEmpty ? c.string(.name) : named
    }()
    day = c.string(.day)
    start = c.string(.start)
    end = c.string(.end)
    period = c.string(.period)
    classId = c.string(.classId)
    id = rawId.isEmpty ? "\(title)-\(day)-\(start)" : rawId
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(title, forKey: .title)
    try c.encode(day, forKey: .day)
    try c.encode(start, forKey: .start)
    try c.encode(end, forKey: .end)
    try c.encode(period, forKey: .period)
    try c.encode(classId, forKey: .classId)
  }

  private enum CodingKeys: String, CodingKey {
    case id, title, name, day, start, end, period, classId
  }
}

struct ScheduleResponse: Codable {
  var classes: [SchoolClass]
  var meetings: [ScheduleMeeting]

  init(classes: [SchoolClass] = [], meetings: [ScheduleMeeting] = []) {
    self.classes = classes
    self.meetings = meetings
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if let nested = try? c.decodeIfPresent(ScheduleResponse.self, forKey: .schedule) {
      classes = nested.classes
      meetings = nested.meetings
      return
    }
    classes = (try? c.decodeIfPresent([SchoolClass].self, forKey: .classes)) ?? []
    meetings = (try? c.decodeIfPresent([ScheduleMeeting].self, forKey: .meetings)) ?? []
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(classes, forKey: .classes)
    try c.encode(meetings, forKey: .meetings)
  }

  private enum CodingKeys: String, CodingKey {
    case classes, meetings, schedule
  }
}

struct NoteVote: Equatable {
  var subject: String
  var confidence: Double?
  var rationale: String

  init(subject: String = "", confidence: Double? = nil, rationale: String = "") {
    self.subject = subject
    self.confidence = confidence
    self.rationale = rationale
  }

  var confidenceLabel: String {
    guard let confidence else { return "" }
    if confidence <= 1 {
      return "\(Int((confidence * 100).rounded()))%"
    }
    return String(format: "%.0f", confidence)
  }
}

extension NoteVote: Codable {
  init(from decoder: Decoder) throws {
    if let text = try? decoder.singleValueContainer().decode(String.self) {
      subject = text
      confidence = nil
      rationale = ""
      return
    }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    subject = c.string(.subject)
    rationale = c.string(.rationale)
    if let value = try? c.decodeIfPresent(Double.self, forKey: .confidence) {
      confidence = value
    } else if let raw = try? c.decodeIfPresent(String.self, forKey: .confidence),
              let value = Double(raw) {
      confidence = value
    } else {
      confidence = nil
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(subject, forKey: .subject)
    try c.encodeIfPresent(confidence, forKey: .confidence)
    if !rationale.isEmpty {
      try c.encode(rationale, forKey: .rationale)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case subject, confidence, rationale
  }
}

struct NoteVotes: Equatable {
  var zeroShot: NoteVote?
  var fineTuned: NoteVote?
  var studentKey: NoteVote?

  init(zeroShot: NoteVote? = nil, fineTuned: NoteVote? = nil, studentKey: NoteVote? = nil) {
    self.zeroShot = zeroShot
    self.fineTuned = fineTuned
    self.studentKey = studentKey
  }
}

private struct FlexibleJSONKey: CodingKey {
  var stringValue: String
  var intValue: Int?

  init(_ value: String) {
    stringValue = value
    intValue = nil
  }

  init?(stringValue: String) {
    self.stringValue = stringValue
    self.intValue = nil
  }

  init?(intValue: Int) {
    self.stringValue = String(intValue)
    self.intValue = intValue
  }
}

extension NoteVotes: Codable {
  init(from decoder: Decoder) throws {
    if var arr = try? decoder.unkeyedContainer() {
      var zero: NoteVote?
      var fine: NoteVote?
      var key: NoteVote?
      while !arr.isAtEnd {
        if let vote = try? arr.decode(LabeledNoteVote.self) {
          switch vote.bucket {
          case .zeroShot: zero = vote.vote
          case .fineTuned: fine = vote.vote
          case .studentKey: key = vote.vote
          }
        } else {
          _ = try? arr.decode(NoteVote.self)
        }
      }
      self.init(zeroShot: zero, fineTuned: fine, studentKey: key)
      return
    }

    let c = try decoder.container(keyedBy: FlexibleJSONKey.self)
    self.init(
      zeroShot: Self.pick(c, [
        "zeroShot", "zero_shot", "zeroShotBert", "zeroShotBERT", "baseBert", "zero-shot BERT",
      ]),
      fineTuned: Self.pick(c, [
        "fineTuned", "fine_tuned", "fineTunedBert", "fineTunedBERT", "fine-tuned BERT",
      ]),
      studentKey: Self.pick(c, [
        "studentKey", "student_key", "studentKeyModel", "student-key", "gptOss", "apiKey",
      ])
    )
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: FlexibleJSONKey.self)
    try c.encodeIfPresent(zeroShot, forKey: FlexibleJSONKey("zeroShot"))
    try c.encodeIfPresent(fineTuned, forKey: FlexibleJSONKey("fineTuned"))
    try c.encodeIfPresent(studentKey, forKey: FlexibleJSONKey("studentKey"))
  }

  private static func pick(
    _ c: KeyedDecodingContainer<FlexibleJSONKey>,
    _ names: [String]
  ) -> NoteVote? {
    for name in names {
      if let vote = try? c.decodeIfPresent(NoteVote.self, forKey: FlexibleJSONKey(name)) {
        return vote
      }
    }
    return nil
  }
}

private struct LabeledNoteVote: Decodable {
  enum Bucket { case zeroShot, fineTuned, studentKey }

  var vote: NoteVote
  var bucket: Bucket

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let label = [c.string(.name), c.string(.label), c.string(.source), c.string(.arm)]
      .first { !$0.isEmpty } ?? ""
    let folded = label.lowercased()
    if folded.contains("fine") {
      bucket = .fineTuned
    } else if folded.contains("student") || folded.contains("key") || folded.contains("gpt") {
      bucket = .studentKey
    } else {
      bucket = .zeroShot
    }
    if let nested = try? c.decodeIfPresent(NoteVote.self, forKey: .vote) {
      vote = nested
    } else {
      vote = try NoteVote(from: decoder)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case name, label, source, arm, vote
  }
}

struct NoteOrchestrator: Equatable {
  var subject: String
  var confidence: Double?
  var rationale: String

  init(subject: String = "", confidence: Double? = nil, rationale: String = "") {
    self.subject = subject
    self.confidence = confidence
    self.rationale = rationale
  }
}

extension NoteOrchestrator: Codable {
  init(from decoder: Decoder) throws {
    if let text = try? decoder.singleValueContainer().decode(String.self) {
      subject = text
      confidence = nil
      rationale = ""
      return
    }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    subject = c.string(.subject)
    rationale = c.string(.rationale)
    if let value = try? c.decodeIfPresent(Double.self, forKey: .confidence) {
      confidence = value
    } else if let raw = try? c.decodeIfPresent(String.self, forKey: .confidence),
              let value = Double(raw) {
      confidence = value
    } else {
      confidence = nil
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(subject, forKey: .subject)
    try c.encodeIfPresent(confidence, forKey: .confidence)
    if !rationale.isEmpty {
      try c.encode(rationale, forKey: .rationale)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case subject, confidence, rationale
  }
}

struct ClassifiedNote: Codable, Identifiable, Equatable {
  var id: String
  var text: String
  var subject: String
  var votes: NoteVotes
  var orchestrator: NoteOrchestrator
  var classId: String
  var researchEventId: String

  init(
    id: String = "",
    text: String = "",
    subject: String = "",
    votes: NoteVotes = NoteVotes(),
    orchestrator: NoteOrchestrator = NoteOrchestrator(),
    classId: String = "",
    researchEventId: String = ""
  ) {
    self.id = id
    self.text = text
    self.subject = subject
    self.votes = votes
    self.orchestrator = orchestrator
    self.classId = classId
    self.researchEventId = researchEventId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    let body = c.string(.text)
    let preview = c.string(.textPreview)
    if !body.isEmpty {
      text = body
    } else if !preview.isEmpty {
      text = preview
    } else {
      let content = c.string(.content)
      text = content.isEmpty ? c.string(.body) : content
    }
    subject = c.string(.subject)
    votes = (try? c.decodeIfPresent(NoteVotes.self, forKey: .votes)) ?? NoteVotes()
    if let orch = try? c.decodeIfPresent(NoteOrchestrator.self, forKey: .orchestrator) {
      orchestrator = orch
    } else {
      orchestrator = NoteOrchestrator(subject: subject)
    }
    classId = c.string(.classId)
    let event = c.string(.researchEventId)
    researchEventId = event.isEmpty ? c.string(.eventId) : event
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(text, forKey: .text)
    try c.encode(subject, forKey: .subject)
    try c.encode(votes, forKey: .votes)
    try c.encode(orchestrator, forKey: .orchestrator)
    try c.encode(classId, forKey: .classId)
    try c.encode(researchEventId, forKey: .researchEventId)
  }

  private enum CodingKeys: String, CodingKey {
    case id, text, textPreview, content, body, subject, votes, orchestrator, classId, researchEventId, eventId
  }
}

struct NotesResponse: Codable {
  var notes: [ClassifiedNote]

  init(notes: [ClassifiedNote] = []) {
    self.notes = notes
  }

  init(from decoder: Decoder) throws {
    if let arr = try? decoder.singleValueContainer().decode([ClassifiedNote].self) {
      notes = arr
      return
    }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    notes = (try? c.decodeIfPresent([ClassifiedNote].self, forKey: .notes)) ?? []
  }
}

struct NoteResponse: Codable {
  var note: ClassifiedNote

  init(note: ClassifiedNote = ClassifiedNote()) {
    self.note = note
  }

  init(from decoder: Decoder) throws {
    if let direct = try? decoder.singleValueContainer().decode(ClassifiedNote.self), !direct.id.isEmpty {
      note = direct
      return
    }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    note = (try? c.decodeIfPresent(ClassifiedNote.self, forKey: .note)) ?? ClassifiedNote()
  }
}

struct CreateNoteBody: Encodable {
  var text: String
}

struct PatchNoteBody: Encodable {
  var subject: String
}
