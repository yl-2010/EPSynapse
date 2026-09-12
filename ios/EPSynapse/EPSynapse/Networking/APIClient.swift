import Foundation

struct APIError: LocalizedError {
  var status: Int
  var message: String

  var errorDescription: String? { message }
}

struct APIClient {
  static let shared = APIClient()

  static let productionBase = "https://api.epsynapse.com"
  static let localBase = "http://127.0.0.1:3006"
  static let useLocalFlag = "eps.useLocalAPI"

  let encoder: JSONEncoder
  let decoder: JSONDecoder
  let session: URLSession

  init(session: URLSession = .shared) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []
    self.encoder = encoder
    self.decoder = JSONDecoder()
    self.session = session
  }

  var baseURL: URL {
    let production = Self.plistString("EPSApiBaseURL") ?? Self.productionBase
    let local = Self.plistString("EPSLocalApiBaseURL") ?? Self.localBase
    #if DEBUG
    let useLocal = UserDefaults.standard.bool(forKey: Self.useLocalFlag) || Self.isSimulator
    if useLocal, let url = URL(string: local) {
      return url
    }
    #endif
    return URL(string: production) ?? URL(string: Self.productionBase)!
  }

  func request<T: Decodable>(
    _ path: String,
    method: String = "GET",
    body: (any Encodable)? = nil,
    sessionId: String,
    timeout: TimeInterval = 20
  ) async throws -> T {
    let data = try await perform(path, method: method, body: body, sessionId: sessionId, timeout: timeout)
    do {
      return try decoder.decode(T.self, from: data)
    } catch {
      throw APIError(status: 0, message: "Could not read the server response.")
    }
  }

  func requestRaw(
    _ path: String,
    method: String = "GET",
    body: (any Encodable)? = nil,
    sessionId: String,
    timeout: TimeInterval = 20
  ) async throws -> (data: Data, json: [String: Any]) {
    let data = try await perform(path, method: method, body: body, sessionId: sessionId, timeout: timeout)
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    return (data, json)
  }

  func listChats(sessionId: String) async throws -> ChatListResponse {
    try await request("/v1/agent/chats", sessionId: sessionId)
  }

  func persistChat(_ body: ChatPersistBody, sessionId: String) async throws -> ChatListItemResponse {
    try await request("/v1/agent/chats", method: "POST", body: body, sessionId: sessionId)
  }

  func loadChat(id: String, sessionId: String) async throws -> ChatDetailResponse {
    try await request("/v1/agent/chats/\(id)", sessionId: sessionId)
  }

  func markChatRead(id: String, sessionId: String) async throws {
    _ = try await requestRaw(
      "/v1/agent/chats/\(id)/read",
      method: "POST",
      body: EmptyJSON(),
      sessionId: sessionId
    )
  }

  func fetchSchedule(sessionId: String) async throws -> ScheduleResponse {
    try await request("/v1/me/schedule", sessionId: sessionId)
  }

  func uploadSchedulePDF(fileURL: URL, sessionId: String) async throws -> ScheduleResponse {
    try await uploadMultipart(
      "/v1/me/schedule/pdf",
      fileURL: fileURL,
      fieldName: "pdf",
      sessionId: sessionId,
      timeout: 90
    )
  }

  func createNote(text: String, sessionId: String) async throws -> NoteResponse {
    try await request(
      "/v1/me/notes",
      method: "POST",
      body: CreateNoteBody(text: text),
      sessionId: sessionId,
      timeout: 90
    )
  }

  func listNotes(sessionId: String) async throws -> NotesResponse {
    try await request("/v1/me/notes", sessionId: sessionId)
  }

  func fetchNote(id: String, sessionId: String) async throws -> NoteResponse {
    try await request("/v1/me/notes/\(Self.pathValue(id))", sessionId: sessionId)
  }

  func patchNote(id: String, subject: String, sessionId: String) async throws -> NoteResponse {
    try await request(
      "/v1/me/notes/\(Self.pathValue(id))",
      method: "PATCH",
      body: PatchNoteBody(subject: subject),
      sessionId: sessionId
    )
  }

  func uploadMultipart<T: Decodable>(
    _ path: String,
    fileURL: URL,
    fieldName: String,
    sessionId: String,
    timeout: TimeInterval = 90
  ) async throws -> T {
    let data = try await performMultipart(
      path,
      fileURL: fileURL,
      fieldName: fieldName,
      sessionId: sessionId,
      timeout: timeout
    )
    do {
      return try decoder.decode(T.self, from: data)
    } catch {
      throw APIError(status: 0, message: "Could not read the server response.")
    }
  }

  func streamChat(
    provider: String,
    messages: [[String: String]],
    sessionId: String,
    apiKey: String,
    onDelta: (_ content: String, _ reasoning: String) -> Void
  ) async throws {
    var request = try makeRequest(
      "/v1/agent/chat",
      method: "POST",
      body: ChatRequestBody(provider: provider, messages: messages),
      sessionId: sessionId,
      timeout: 90
    )
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    if !apiKey.isEmpty {
      request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    }

    let (bytes, response) = try await session.bytes(for: request)
    let http = try httpResponse(response)
    if !(200 ... 299).contains(http.statusCode) {
      var collected = Data()
      for try await byte in bytes {
        collected.append(byte)
      }
      throw apiError(status: http.statusCode, data: collected)
    }

    for try await line in bytes.lines {
      let trimmed = line.trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
      guard trimmed.hasPrefix("data:") else { continue }
      let chunk = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
      emitChatDelta(chunk, onDelta: onDelta)
    }
  }

  private func performMultipart(
    _ path: String,
    fileURL: URL,
    fieldName: String,
    sessionId: String,
    timeout: TimeInterval
  ) async throws -> Data {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw APIError(status: 0, message: "Bad API path.")
    }
    let accessed = fileURL.startAccessingSecurityScopedResource()
    defer {
      if accessed { fileURL.stopAccessingSecurityScopedResource() }
    }
    let fileData: Data
    do {
      fileData = try Data(contentsOf: fileURL)
    } catch {
      throw APIError(status: 0, message: "Could not read that PDF.")
    }
    let boundary = "eps-\(UUID().uuidString)"
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    if !sessionId.isEmpty {
      request.setValue(sessionId, forHTTPHeaderField: "X-EPSynapse-Session")
    }
    let filename = fileURL.lastPathComponent.isEmpty ? "schedule.pdf" : fileURL.lastPathComponent
    request.httpBody = Self.multipartBody(
      fileData: fileData,
      fileName: filename,
      fieldNames: [fieldName, "pdf", "file"],
      boundary: boundary
    )

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw APIError(status: 0, message: "Could not reach api.epsynapse.com.")
    }
    let http = try httpResponse(response)
    if !(200 ... 299).contains(http.statusCode) {
      throw apiError(status: http.statusCode, data: data)
    }
    return data
  }

  private static func multipartBody(
    fileData: Data,
    fileName: String,
    fieldNames: [String],
    boundary: String
  ) -> Data {
    var body = Data()
    var seen = Set<String>()
    for fieldName in fieldNames {
      if fieldName.isEmpty || !seen.insert(fieldName).inserted { continue }
      let header = """
      --\(boundary)\r
      Content-Disposition: form-data; name="\(fieldName)"; filename="\(fileName)"\r
      Content-Type: application/pdf\r
      \r

      """
      body.append(Data(header.utf8))
      body.append(fileData)
      body.append(Data("\r\n".utf8))
    }
    body.append(Data("--\(boundary)--\r\n".utf8))
    return body
  }

  private func perform(
    _ path: String,
    method: String,
    body: (any Encodable)?,
    sessionId: String,
    timeout: TimeInterval
  ) async throws -> Data {
    let request = try makeRequest(path, method: method, body: body, sessionId: sessionId, timeout: timeout)
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw APIError(status: 0, message: "Could not reach api.epsynapse.com.")
    }
    let http = try httpResponse(response)
    if !(200 ... 299).contains(http.statusCode) {
      throw apiError(status: http.statusCode, data: data)
    }
    return data
  }

  private func makeRequest(
    _ path: String,
    method: String,
    body: (any Encodable)?,
    sessionId: String,
    timeout: TimeInterval
  ) throws -> URLRequest {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw APIError(status: 0, message: "Bad API path.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = timeout
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if !sessionId.isEmpty {
      request.setValue(sessionId, forHTTPHeaderField: "X-EPSynapse-Session")
    }
    if let body {
      request.httpBody = try encoder.encode(AnyEncodable(body))
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  private func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
    guard let http = response as? HTTPURLResponse else {
      throw APIError(status: 0, message: "Could not reach api.epsynapse.com.")
    }
    return http
  }

  private func apiError(status: Int, data: Data) -> APIError {
    if let parsed = try? decoder.decode(ServerErrorBody.self, from: data),
       let message = parsed.error, !message.isEmpty
    {
      return APIError(status: status, message: message)
    }
    if let text = String(data: data, encoding: .utf8) {
      let clipped = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !clipped.isEmpty {
        return APIError(status: status, message: String(clipped.prefix(200)))
      }
    }
    return APIError(status: status, message: "Request failed (\(status))")
  }

  private func emitChatDelta(
    _ raw: String,
    onDelta: (_ content: String, _ reasoning: String) -> Void
  ) {
    let event = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !event.isEmpty, event != "[DONE]" else { return }
    guard let data = event.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let choices = obj["choices"] as? [[String: Any]]
    else { return }
    let choice = choices.first ?? [:]
    let src = (choice["delta"] as? [String: Any]) ?? (choice["message"] as? [String: Any]) ?? [:]
    let content = textFromModelField(src["content"])
    let reasoning = textFromModelField(src["reasoning"]).isEmpty
      ? textFromModelField(src["reasoning_content"])
      : textFromModelField(src["reasoning"])
    if !content.isEmpty || !reasoning.isEmpty {
      onDelta(content, reasoning)
    }
  }

  private func textFromModelField(_ value: Any?) -> String {
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    if let parts = value as? [Any] {
      return parts.map { textFromModelField($0) }.joined()
    }
    if let obj = value as? [String: Any] {
      let direct = textFromModelField(obj["text"])
      if !direct.isEmpty { return direct }
      let content = textFromModelField(obj["content"])
      if !content.isEmpty { return content }
      return textFromModelField(obj["reasoning"])
    }
    return ""
  }

  private static func pathValue(_ raw: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/")
    return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
  }

  private static func plistString(_ key: String) -> String? {
    guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static var isSimulator: Bool {
    #if targetEnvironment(simulator)
    return true
    #else
    return false
    #endif
  }
}

private struct AnyEncodable: Encodable {
  let wrapped: any Encodable

  init(_ wrapped: any Encodable) {
    self.wrapped = wrapped
  }

  func encode(to encoder: Encoder) throws {
    try wrapped.encode(to: encoder)
  }
}

private struct ServerErrorBody: Decodable {
  var error: String?
}
