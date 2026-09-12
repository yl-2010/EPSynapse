import Combine
import Foundation
import GoogleSignIn
import UIKit

@MainActor
final class SessionStore: ObservableObject {
  static let shared = SessionStore()

  static let onedriveIdle = "School OneDrive. Tap Connect, then sign in with @eastsideprep.org."
  static let outlookIdle = "School Outlook. Same Microsoft sign-in, mail only."
  static let keyIdle = "Paste the gsk_ key here, tap Save key, wait until Chat key says Groq, then ask in chat. Do not paste the key in the chat box."
  static let setupGuide = """
This box is only for questions. The Groq key goes in Settings, not here.

1. Sign in with Google if you are not already.
2. Open Settings.
3. Open Chat key (Agent on iPhone).
4. Open console.groq.com/keys. Sign up with Google. No credit card. Create API Key and copy the value that starts with gsk_. Groq shows the full key only once.
5. Paste it in the API key field. Leave Model on Groq.
6. Tap Save key. Do not only save School.
7. Chat key must say Groq, not Add a Groq key.
8. Close settings. Type a question here. Homework, a class, Canvas, the day.

If you skip Save key, chat will send you back to these steps.
"""
  static let readyGuide = "Your Groq key is saved on this account. Ask about a class, Canvas, or the day."
  static let googleFirst = "Sign in with Google first."
  static let signedInHint = "Signed in with Google. School and student ID let us match you at school."

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

  var isSignedIn: Bool {
    guard !sessionId.isEmpty, let profile else { return false }
    return !profile.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !profile.googleName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

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

    await configureGoogleSignIn()

    async let configTask: [AgentProvider] = loadProviders()
    if sessionId.isEmpty {
      _ = await restoreGoogleSessionIfNeeded()
      providers = await configTask
      paintConnections()
      await syncAgentFromAccount()
      return
    }

    do {
      let me: Profile = try await api.request("/v1/me", sessionId: sessionId)
      profile = me
      rememberSession(me.sessionId)
    } catch let error as APIError where error.status == 401 {
      profile = nil
      _ = await restoreGoogleSessionIfNeeded()
    } catch {
      profile = nil
    }

    providers = await configTask
    paintConnections()
    await syncAgentFromAccount()
  }

  func signInWithGoogle() async {
    settingsStatus = "Signing in…"
    await configureGoogleSignIn()
    guard GIDSignIn.sharedInstance.configuration != nil || Self.plistClientID() != nil else {
      settingsStatus = "Google sign-in is not configured yet."
      return
    }
    guard let presenter = Self.presentingViewController() else {
      settingsStatus = "Could not open Google sign-in."
      return
    }
    do {
      let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
      try await exchangeGoogleUser(result.user)
      settingsStatus = Self.signedInHint
      paintConnections()
      await syncAgentFromAccount()
    } catch {
      if Self.isGoogleCancel(error) {
        settingsStatus = ""
        return
      }
      settingsStatus = (error as? APIError)?.message ?? error.localizedDescription
    }
  }

  func save(school: String, studentId: String, canvasHost: String, canvasToken: String) async {
    if sessionId.isEmpty {
      settingsStatus = Self.googleFirst
      return
    }
    let id = studentId.trimmingCharacters(in: .whitespacesAndNewlines)
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
      settingsStatus = me.signedInName.isEmpty ? "Saved." : "Saved · \(me.signedInName)"
      paintConnections()
    } catch let error as APIError where error.status == 401 {
      settingsStatus = Self.googleFirst
    } catch {
      settingsStatus = (error as? APIError)?.message ?? "Could not save."
    }
  }

  func searchSchools(query: String) async -> [SchoolHit] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let path: String
    if trimmed.isEmpty {
      path = "/v1/schools"
    } else {
      path = "/v1/schools?q=\(Self.queryValue(trimmed))"
    }
    do {
      let wrapped: SchoolsResponse = try await api.request(path, sessionId: sessionId)
      return wrapped.schools
    } catch {
      return []
    }
  }

  func startOnedrive() async {
    guard profile != nil, !sessionId.isEmpty else {
      onedriveStatus = Self.googleFirst
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
      outlookStatus = Self.googleFirst
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

  func saveKey(_ key: String) async {
    guard isSignedIn else { return }
    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      keyStatus = "Paste a key first."
      return
    }
    keyStatus = "Saving…"
    await persistAgent(modelKey: trimmed, provider: provider)
  }

  func clearKey() async {
    guard isSignedIn else { return }
    keyStatus = "Clearing…"
    await persistAgent(clear: true)
  }

  func saveProvider(_ id: String) async {
    let next = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !next.isEmpty else { return }
    provider = next
    guard isSignedIn else { return }
    if profile?.modelProvider == next { return }
    await persistAgent(provider: next)
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
    GIDSignIn.sharedInstance.signOut()
    sessionId = ""
    profile = nil
    settingsStatus = ""
    paintConnections()
  }

  private func configureGoogleSignIn() async {
    var iosClientId = Self.plistClientID() ?? ""
    var serverClientId = Self.plistString("GIDServerClientID") ?? ""
    do {
      let cfg: GoogleAuthConfig = try await api.request("/v1/auth/google/config", sessionId: "")
      if iosClientId.isEmpty {
        iosClientId = cfg.iosClientId.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if serverClientId.isEmpty {
        serverClientId = cfg.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
      }
    } catch {
      /* config route may not be up yet; plist still works */
    }
    iosClientId = iosClientId.trimmingCharacters(in: .whitespacesAndNewlines)
    serverClientId = serverClientId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !iosClientId.isEmpty else { return }
    GIDSignIn.sharedInstance.configuration = GIDConfiguration(
      clientID: iosClientId,
      serverClientID: serverClientId.isEmpty ? nil : serverClientId
    )
  }

  @discardableResult
  private func restoreGoogleSessionIfNeeded() async -> Bool {
    do {
      let user = try await GIDSignIn.sharedInstance.restorePreviousSignIn()
      try await exchangeGoogleUser(user)
      if settingsStatus.isEmpty {
        settingsStatus = Self.signedInHint
      }
      return true
    } catch {
      return false
    }
  }

  private func exchangeGoogleUser(_ user: GIDGoogleUser) async throws {
    guard let idToken = user.idToken?.tokenString, !idToken.isEmpty else {
      throw APIError(status: 0, message: "Google did not return an ID token.")
    }
    let me: Profile = try await api.request(
      "/v1/auth/google",
      method: "POST",
      body: GoogleAuthBody(idToken: idToken),
      sessionId: sessionId
    )
    profile = me
    rememberSession(me.sessionId)
  }

  private func rememberSession(_ sid: String?) {
    guard let sid, !sid.isEmpty else { return }
    sessionId = sid
  }

  private func syncAgentFromAccount() async {
    if let me = profile, !me.modelProvider.isEmpty {
      provider = me.modelProvider
    }
    if profile?.modelKeySet == true {
      if !modelKey.isEmpty { modelKey = "" }
      refreshKeyStatus()
      return
    }
    let leftover = modelKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if isSignedIn, !leftover.isEmpty {
      await persistAgent(modelKey: leftover, provider: provider)
      modelKey = ""
      return
    }
    refreshKeyStatus()
  }

  private func persistAgent(modelKey: String? = nil, provider: String? = nil, clear: Bool = false) async {
    guard !sessionId.isEmpty else { return }
    do {
      let me: Profile = try await api.request(
        "/v1/me/agent",
        method: "POST",
        body: SaveAgentBody(provider: provider, modelKey: modelKey, clear: clear),
        sessionId: sessionId
      )
      profile = me
      if !me.modelProvider.isEmpty {
        self.provider = me.modelProvider
      }
      if me.modelKeySet || clear {
        self.modelKey = ""
      }
      refreshKeyStatus()
    } catch {
      keyStatus = (error as? APIError)?.message ?? "Could not save the key."
    }
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
      onedriveStatus = "Enter this code on the Microsoft page, then come back here. Allow files access."
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
      outlookStatus = "Enter this code on the Microsoft page, then come back here. Allow mail access."
      olCode = pending.user_code
      olURI = pending.verification_uri
    } else {
      outlookStatus = Self.outlookIdle
      olCode = ""
      olURI = ""
    }
  }

  private func refreshKeyStatus() {
    if profile?.modelKeySet == true {
      keyStatus = "Using your \(provider) key on this account"
      return
    }
    if !modelKey.isEmpty {
      keyStatus = "Using your \(provider) key on this account"
      return
    }
    keyStatus = Self.keyIdle
  }

  private static func presentingViewController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    let window = windows.first(where: \.isKeyWindow) ?? windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }

  private static func plistClientID() -> String? {
    plistString("GIDClientID") ?? plistString("EPSGoogleiOSClientID")
  }

  private static func plistString(_ key: String) -> String? {
    guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func queryValue(_ raw: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
  }

  private static func isGoogleCancel(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain.contains("GIDSignIn") && ns.code == -5 { return true }
    return error.localizedDescription.lowercased().contains("cancel")
  }
}
