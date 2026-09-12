import Combine
import Foundation

@MainActor
final class SessionStore: ObservableObject {
  static let shared = SessionStore()

  static let onedriveIdle = "School OneDrive. Tap Connect, then sign in with @eastsideprep.org."
  static let outlookIdle = "School Outlook. Same Microsoft sign-in, mail only."
  static let keyIdle = "No model key. Groq is the short path: console.groq.com/keys"
  static let studentIdRequired = "Student ID is required."

  @Published var sessionId: String {
    didSet { UserDefaults.standard.set(sessionId, forKey: Keys.sid) }
  }

  @Published var profile: Profile?

  @Published var modelKey: String {
    didSet { UserDefaults.standard.set(modelKey, forKey: Keys.key) }
  }

  @Published var provider: String {
    didSet {
      UserDefaults.standard.set(provider, forKey: Keys.provider)
      refreshKeyStatus()
    }
  }

  @Published var providers: [AgentProvider] = []
  @Published var settingsStatus = ""
  @Published var onedriveStatus = SessionStore.onedriveIdle
  @Published var outlookStatus = SessionStore.outlookIdle
  @Published var keyStatus = SessionStore.keyIdle
  @Published var odCode = ""
  @Published var odURI = ""
  @Published var olCode = ""
  @Published var olURI = ""
  @Published var isBooting = true

  private let api = APIClient.shared

  private enum Keys {
    static let sid = "epsynapse.sid"
    static let key = "epsynapse.agent.key"
    static let provider = "epsynapse.agent.provider"
  }

  init() {
    let defaults = UserDefaults.standard
    sessionId = defaults.string(forKey: Keys.sid) ?? ""
    modelKey = defaults.string(forKey: Keys.key) ?? ""
    provider = defaults.string(forKey: Keys.provider) ?? "groq"
    refreshKeyStatus()
  }

  func boot() async {
    isBooting = true
    defer { isBooting = false }

    async let configTask: [AgentProvider] = loadProviders()
    if sessionId.isEmpty {
      providers = await configTask
      profile = nil
      paintConnections()
      refreshKeyStatus()
      return
    }

    do {
      let me: Profile = try await api.request("/v1/me", sessionId: sessionId)
      profile = me
      rememberSession(me.sessionId)
    } catch let error as APIError where error.status == 401 {
      profile = nil
    } catch {
      profile = nil
    }

    providers = await configTask
    paintConnections()
    refreshKeyStatus()
  }

  func save(school: String, studentId: String, canvasHost: String, canvasToken: String) async {
    let id = studentId.trimmingCharacters(in: .whitespacesAndNewlines)
    if id.isEmpty {
      settingsStatus = Self.studentIdRequired
      return
    }
    settingsStatus = "Saving…"
    let body = SaveMeBody(
      school: school.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? "Eastside Prep"
        : school.trimmingCharacters(in: .whitespacesAndNewlines),
      studentId: id,
      canvasHost: canvasHost.trimmingCharacters(in: .whitespacesAndNewlines),
      canvasToken: canvasToken.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    do {
      let me: Profile = try await api.request("/v1/me", method: "POST", body: body, sessionId: sessionId)
      profile = me
      rememberSession(me.sessionId)
      settingsStatus = me.displayName.isEmpty ? "Saved." : "Saved · \(me.displayName)"
      paintConnections()
    } catch {
      settingsStatus = (error as? APIError)?.message ?? "Could not save."
    }
  }

  func startOnedrive() async {
    guard profile != nil, !sessionId.isEmpty else {
      onedriveStatus = "Save school and student ID first."
      return
    }
    do {
      let started: DeviceStartResponse = try await api.request(
        "/v1/me/onedrive/start",
        method: "POST",
        body: EmptyJSON(),
        sessionId: sessionId
      )
      if started.user_code.isEmpty {
        onedriveStatus = started.message.isEmpty
          ? "Microsoft would not start school sign-in."
          : started.message
        odCode = ""
        odURI = ""
        return
      }
      profile?.onedrivePending = DevicePending(
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        message: started.message
      )
      paintConnections()
    } catch {
      onedriveStatus = (error as? APIError)?.message ?? "Could not start OneDrive."
    }
  }

  func startOutlook() async {
    guard profile != nil, !sessionId.isEmpty else {
      outlookStatus = "Save school and student ID first."
      return
    }
    do {
      let started: DeviceStartResponse = try await api.request(
        "/v1/me/outlook/start",
        method: "POST",
        body: EmptyJSON(),
        sessionId: sessionId,
        timeout: 20
      )
      if started.user_code.isEmpty {
        outlookStatus = started.message.isEmpty
          ? "Microsoft would not start Outlook sign-in."
          : started.message
        olCode = ""
        olURI = ""
        return
      }
      profile?.outlookPending = DevicePending(
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        message: started.message
      )
      paintConnections()
    } catch {
      outlookStatus = (error as? APIError)?.message ?? "Could not start Outlook."
    }
  }

  func pollConnections() async {
    guard !sessionId.isEmpty else { return }
    let watchOnedrive = profile?.onedriveConnected != true
      && (profile?.onedrivePending?.isActive == true || !odCode.isEmpty)
    let watchOutlook = profile?.outlookConnected != true
      && (profile?.outlookPending?.isActive == true || !olCode.isEmpty)
    guard watchOnedrive || watchOutlook else { return }

    async let od: ConnectionStatusResponse? = {
      guard watchOnedrive else { return nil }
      return await self.fetchStatus("/v1/me/onedrive/status")
    }()
    async let ol: ConnectionStatusResponse? = {
      guard watchOutlook else { return nil }
      return await self.fetchStatus("/v1/me/outlook/status")
    }()
    let odStatus = await od
    let olStatus = await ol

    if let odStatus {
      if odStatus.connected {
        profile?.onedriveConnected = true
        profile?.onedriveEmail = odStatus.email
        profile?.onedrivePending = nil
      } else {
        profile?.onedrivePending = odStatus.pending
      }
    }
    if let olStatus {
      if olStatus.connected {
        profile?.outlookConnected = true
        profile?.outlookEmail = olStatus.email
        profile?.outlookPending = nil
      } else if let pending = olStatus.pending, pending.isActive {
        profile?.outlookPending = pending
      }
    }
    paintConnections()
  }

  func saveKey(_ key: String) {
    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      keyStatus = "Paste a key first."
      return
    }
    modelKey = trimmed
    refreshKeyStatus()
  }

  func clearKey() {
    modelKey = ""
    refreshKeyStatus()
  }

  func logout() async {
    if !sessionId.isEmpty {
      let _: LogoutResponse? = try? await api.request(
        "/v1/me/logout",
        method: "POST",
        body: EmptyJSON(),
        sessionId: sessionId
      )
    }
    sessionId = ""
    profile = nil
    settingsStatus = ""
    paintConnections()
  }

  private func rememberSession(_ sid: String?) {
    guard let sid, !sid.isEmpty else { return }
    sessionId = sid
  }

  private func loadProviders() async -> [AgentProvider] {
    do {
      let cfg: AgentConfigResponse = try await api.request("/v1/agent/config", sessionId: sessionId)
      if !cfg.providers.isEmpty { return cfg.providers }
    } catch {
      /* fall through to the built-in list */
    }
    return [
      AgentProvider(id: "groq", label: "Groq", recommended: true),
      AgentProvider(id: "gemini", label: "Gemini"),
      AgentProvider(id: "openrouter", label: "OpenRouter"),
    ]
  }

  private func fetchStatus(_ path: String) async -> ConnectionStatusResponse? {
    try? await api.request(path, sessionId: sessionId, timeout: 15)
  }

  private func paintConnections() {
    guard let me = profile else {
      onedriveStatus = Self.onedriveIdle
      outlookStatus = Self.outlookIdle
      odCode = ""
      odURI = ""
      olCode = ""
      olURI = ""
      return
    }

    if me.onedriveConnected {
      onedriveStatus = me.onedriveEmail.isEmpty ? "OneDrive connected" : "OneDrive · \(me.onedriveEmail)"
      odCode = ""
      odURI = ""
    } else if let pending = me.onedrivePending, pending.isActive {
      onedriveStatus = "Enter this code on the Microsoft page, then sign in with your school email. Allow files access."
      odCode = pending.user_code
      odURI = pending.verification_uri
    } else {
      onedriveStatus = Self.onedriveIdle
      odCode = ""
      odURI = ""
    }

    if me.outlookConnected {
      outlookStatus = me.outlookEmail.isEmpty ? "Outlook connected" : "Outlook · \(me.outlookEmail)"
      olCode = ""
      olURI = ""
    } else if let pending = me.outlookPending, pending.isActive {
      outlookStatus = "Enter this code on the Microsoft page, then sign in with your school email. Allow mail access."
      olCode = pending.user_code
      olURI = pending.verification_uri
    } else {
      outlookStatus = Self.outlookIdle
      olCode = ""
      olURI = ""
    }
  }

  private func refreshKeyStatus() {
    if modelKey.isEmpty {
      keyStatus = Self.keyIdle
      return
    }
    keyStatus = "Using your \(provider) key · ends \(String(modelKey.suffix(4)))"
  }
}
