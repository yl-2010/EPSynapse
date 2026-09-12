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
}

struct Profile: Codable, Equatable {
  var school: String
  var studentId: String
  var canvasHost: String
  var displayName: String
  var canvasConnected: Bool
  var onedriveConnected: Bool
  var outlookConnected: Bool
  var onedriveEmail: String
  var outlookEmail: String
  var onedrivePending: DevicePending?
  var outlookPending: DevicePending?
  var sessionId: String?

  init(
    school: String = "",
    studentId: String = "",
    canvasHost: String = "",
    displayName: String = "",
    canvasConnected: Bool = false,
    onedriveConnected: Bool = false,
    outlookConnected: Bool = false,
    onedriveEmail: String = "",
    outlookEmail: String = "",
    onedrivePending: DevicePending? = nil,
    outlookPending: DevicePending? = nil,
    sessionId: String? = nil
  ) {
    self.school = school
    self.studentId = studentId
    self.canvasHost = canvasHost
    self.displayName = displayName
    self.canvasConnected = canvasConnected
    self.onedriveConnected = onedriveConnected
    self.outlookConnected = outlookConnected
    self.onedriveEmail = onedriveEmail
    self.outlookEmail = outlookEmail
    self.onedrivePending = onedrivePending
    self.outlookPending = outlookPending
    self.sessionId = sessionId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    school = c.string(.school)
    studentId = c.string(.studentId)
    canvasHost = c.string(.canvasHost)
    displayName = c.string(.displayName)
    canvasConnected = c.bool(.canvasConnected)
    onedriveConnected = c.bool(.onedriveConnected)
    outlookConnected = c.bool(.outlookConnected)
    onedriveEmail = c.string(.onedriveEmail)
    outlookEmail = c.string(.outlookEmail)
    onedrivePending = try c.decodeIfPresent(DevicePending.self, forKey: .onedrivePending)
    outlookPending = try c.decodeIfPresent(DevicePending.self, forKey: .outlookPending)
    let sid = c.string(.sessionId)
    sessionId = sid.isEmpty ? nil : sid
  }
}

struct DevicePending: Codable, Equatable {
  var user_code: String
  var verification_uri: String
  var message: String

  init(user_code: String = "", verification_uri: String = "", message: String = "") {
    self.user_code = user_code
    self.verification_uri = verification_uri
    self.message = message
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    user_code = c.string(.user_code)
    verification_uri = c.string(.verification_uri)
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

  init(
    id: String = "",
    canvasId: String = "",
    canvasLink: String = "",
    title: String = "",
    courseName: String = "",
    courseId: String = "",
    due: String = "",
    tag: String = "",
    done: Bool = false
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
  }
}

struct DriveFile: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var webUrl: String

  init(id: String = "", name: String = "", webUrl: String = "") {
    self.id = id
    self.name = name
    self.webUrl = webUrl
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = c.string(.id)
    name = c.string(.name)
    webUrl = c.string(.webUrl)
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

  init(
    id: String = "",
    subject: String = "",
    from: String = "",
    fromAddress: String = "",
    preview: String = "",
    body: String = "",
    received: String = "",
    unread: Bool = false
  ) {
    self.id = id
    self.subject = subject
    self.from = from
    self.fromAddress = fromAddress
    self.preview = preview
    self.body = body
    self.received = received
    self.unread = unread
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

struct ChatRequestBody: Encodable {
  var provider: String
  var messages: [[String: String]]
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

struct FilesResponse: Codable {
  var files: [DriveFile]

  init(files: [DriveFile] = []) {
    self.files = files
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    files = (try? c.decodeIfPresent([DriveFile].self, forKey: .files)) ?? []
  }
}

struct MessagesResponse: Codable {
  var messages: [MailMessage]

  init(messages: [MailMessage] = []) {
    self.messages = messages
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    messages = (try? c.decodeIfPresent([MailMessage].self, forKey: .messages)) ?? []
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
  var message: String
  var interval: Int

  init(user_code: String = "", verification_uri: String = "", message: String = "", interval: Int = 0) {
    self.user_code = user_code
    self.verification_uri = verification_uri
    self.message = message
    self.interval = interval
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    user_code = c.string(.user_code)
    verification_uri = c.string(.verification_uri)
    message = c.string(.message)
    interval = c.int(.interval)
  }
}

struct ConnectionStatusResponse: Codable {
  var connected: Bool
  var pending: DevicePending?
  var email: String

  init(connected: Bool = false, pending: DevicePending? = nil, email: String = "") {
    self.connected = connected
    self.pending = pending
    self.email = email
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    connected = c.bool(.connected)
    pending = try c.decodeIfPresent(DevicePending.self, forKey: .pending)
    email = c.string(.email)
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
