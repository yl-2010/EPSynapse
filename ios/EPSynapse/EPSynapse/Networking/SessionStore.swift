import AuthenticationServices
import Combine
import Foundation
import GoogleSignIn
import UIKit

/// What a Microsoft settings pane should draw. One value per service.
enum MSPaneState: Equatable {
  /// Nothing started. Show the steps and a Connect button.
  case idle
  /// The server can read this service with the student's own token.
  case connected(email: String)
  /// The judges' demo account. Uses this Mac's school sign-in. No Disconnect.
  case studio(email: String)
  /// Microsoft or the school tenant refused. `needsAdminApproval` means IT has to consent once.
  case denied(reason: String, needsAdminApproval: Bool)
  /// Browser OAuth flow. The web sign-in sheet is open or the callback is on its way.
  case pendingBrowser(authorizeUrl: String)
  /// The API has no EPSynapse Entra app registration. Connect stays disabled.
  case off
  /// Something failed on our side. Show the message and let them try again.
  case error(String)

  var isConnected: Bool {
    switch self {
    case .connected, .studio: true
    default: false
    }
  }

  var isOff: Bool {
    if case .off = self { return true }
    return false
  }
}

@MainActor
final class SessionStore: ObservableObject {
  static let shared = SessionStore()

  static let msReturnTo = "epsynapse://ms"
  static let msCallbackScheme = "epsynapse"
  static let msCallbackHost = "ms"
  static let keyIdle = "Paste the gsk_ key here, tap Save key, wait until Chat key says Groq, then ask in chat. Do not paste the key in the chat box."
  static let googleFirst = "Sign in with Google first."
  static let signedInHint = "Signed in with Google."

  /// Front doors on the logged-out screen. Raw values match the server's `door` field.
  enum Door: String {
    /// Eastside Prep. Microsoft school sign-in, four11 schedule and Microsoft apps. Not live yet.
    case eps
    /// Any other school. Google sign-in, upload your own schedule, bring your own keys.
    case other
  }

  @Published var sessionId: String {
    didSet { UserDefaults.standard.set(sessionId, forKey: Keys.sid) }
  }

  @Published var profile: Profile?

  /// Which door the student last picked on this device. nil until they choose.
  /// Only "other" is restored on launch, so the EPS panel never opens by itself.
  @Published var door: Door? {
    didSet {
      if let door {
        UserDefaults.standard.set(door.rawValue, forKey: Keys.door)
      } else {
        UserDefaults.standard.removeObject(forKey: Keys.door)
      }
    }
  }

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
  @Published var keyStatus = SessionStore.keyIdle
  @Published var isBooting = true

  /// Per-service pane state, recomputed from `profile` plus local pending flags.
  @Published var msStates: [MSService: MSPaneState] = [:]
  /// One-line confirmations under a pane, like "Request sent to it@...".
  @Published var msNotes: [MSService: String] = [:]
  /// Consent-request text fetched for the Copy button, per service.
  @Published var msConsent: [MSService: MSConsentRequest] = [:]

  private var msBrowserPending: [MSService: String] = [:]
  private var msLocalDenied: [MSService: String] = [:]
  private var msErrors: [MSService: String] = [:]
  private var msBusy: Set<MSService> = []
  private var msForcedOff = false
  private var authSession: ASWebAuthenticationSession?
  private let authPresenter = MSAuthPresenter()
  private var pausedObserver: AnyCancellable?

  var isSignedIn: Bool {
    guard !sessionId.isEmpty, let profile else { return false }
    return !profile.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !profile.googleName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Signed in, but the server is holding the account back. Show the paused card.
  var isPaused: Bool {
    isSignedIn && profile?.paused == true
  }

  /// Signed in and allowed past /v1/me. Gates the dashboard, chat, and settings.
  var canUseDashboard: Bool {
    isSignedIn && !isPaused
  }

  private let api = APIClient.shared

  private enum Keys {
    static let sid = "epsynapse.sid"
    static let key = "epsynapse.agent.key"
    static let provider = "epsynapse.agent.provider"
    static let door = "epsynapse.door"
  }

  init() {
    let defaults = UserDefaults.standard
    sessionId = defaults.string(forKey: Keys.sid) ?? ""
    modelKey = defaults.string(forKey: Keys.key) ?? ""
    provider = defaults.string(forKey: Keys.provider) ?? "groq"
    door = defaults.string(forKey: Keys.door).flatMap(Door.init(rawValue:))
    refreshKeyStatus()
    pausedObserver = NotificationCenter.default.publisher(for: .epsAccountPaused)
      .receive(on: RunLoop.main)
      .sink { [weak self] note in
        let info = note.userInfo ?? [:]
        let message = (info["error"] as? String) ?? ""
        let door = (info["door"] as? String) ?? ""
        Task { @MainActor [weak self] in
          await self?.markPaused(message: message, door: door)
        }
      }
  }

  /// Remembers which front door the student tapped. Only "other" is auto-restored.
  func chooseDoor(_ next: Door?) {
    door = next
  }

  /// Called when any authenticated route returns 423 `paused: true`. Flips the
  /// profile into the paused state right away, then re-reads /v1/me (which still
  /// works while paused) so the card shows the server's `pausedMessage` verbatim.
  func markPaused(message: String, door rawDoor: String) async {
    guard !sessionId.isEmpty, var me = profile else { return }
    if me.paused, !me.pausedMessage.isEmpty { return }
    me.paused = true
    if !message.isEmpty { me.pausedMessage = message }
    if rawDoor == "eps" || rawDoor == "other" { me.door = rawDoor }
    profile = me
    await reloadMe()
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
      door = .other
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

  /// POST /v1/me with Canvas fields only. School and student ID are gone from the API.
  func saveCanvas(canvasHost: String, canvasToken: String) async {
    if sessionId.isEmpty {
      settingsStatus = Self.googleFirst
      return
    }
    settingsStatus = "Saving…"
    let body = SaveMeBody(
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
    } catch let error as APIError where error.isPaused {
      settingsStatus = ""
    } catch {
      settingsStatus = (error as? APIError)?.message ?? "Could not save."
    }
  }

  // MARK: Microsoft connect

  func msState(_ service: MSService) -> MSPaneState {
    msStates[service] ?? .idle
  }

  var isMicrosoftSignInOff: Bool {
    msForcedOff || profile?.isMicrosoftSignInOff == true
  }

  func adminConsentURL(for service: MSService) -> URL? {
    if isMicrosoftSignInOff { return nil }
    let raw = [
      msConsent[service]?.adminConsentUrl ?? "",
      profile?.consentRequest?.adminConsentUrl ?? "",
      profile?.adminConsentUrl ?? "",
    ].first { !$0.isEmpty } ?? ""
    return URL(string: raw)
  }

  /// Starts Microsoft sign-in for one service. The API returns authorizeUrl for a
  /// browser PKCE flow. ASWebAuthenticationSession waits for epsynapse://ms?... then
  /// we reload /v1/me so the pane matches the server.
  func connectMicrosoft(_ service: MSService) async {
    guard profile != nil, !sessionId.isEmpty else {
      msErrors[service] = Self.googleFirst
      paintConnections()
      return
    }
    if isMicrosoftSignInOff {
      paintConnections()
      return
    }
    guard !msBusy.contains(service) else { return }
    msBusy.insert(service)
    defer { msBusy.remove(service) }

    msErrors[service] = nil
    msLocalDenied[service] = nil
    msNotes[service] = nil
    msBrowserPending[service] = nil

    let started: MSStartResponse
    do {
      started = try await api.msStart(service: service, returnTo: Self.msReturnTo, sessionId: sessionId)
    } catch {
      msErrors[service] = (error as? APIError)?.message ?? "Could not start \(service.title) sign-in."
      paintConnections()
      return
    }

    if started.isOff {
      msForcedOff = true
      msBrowserPending[service] = nil
      paintConnections()
      return
    }

    if !started.adminConsentUrl.isEmpty {
      profile?.adminConsentUrl = started.adminConsentUrl
    }

    if started.isBrowserFlow {
      let url = started.browserURL
      msForcedOff = false
      msBrowserPending[service] = url
      paintConnections()
      await runBrowserSignIn(service, authorizeUrl: url)
      return
    }

    let fallback = started.error.isEmpty ? started.message : started.error
    msErrors[service] = fallback.isEmpty ? "Microsoft would not start \(service.title) sign-in." : fallback
    paintConnections()
  }

  /// Handles epsynapse://ms?service=onenote&result=connected|denied|error&reason=...&email=...
  /// Returns false if the URL is not ours.
  @discardableResult
  func handleMicrosoftCallback(_ url: URL) async -> Bool {
    guard Self.isMicrosoftCallback(url) else { return false }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String {
      (items.first { $0.name == name }?.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let service = MSService(rawValue: value("service").lowercased())
    let result = value("result").lowercased()
    let reason = value("reason")

    if let service {
      msBrowserPending[service] = nil
      switch result {
      case "denied":
        // Empty reason is fine. paneState fills in msDenied or the generic line.
        msLocalDenied[service] = reason
      case "error":
        msErrors[service] = reason.isEmpty ? "Microsoft sign-in failed." : reason
      default:
        break
      }
    } else {
      msBrowserPending.removeAll()
    }
    await reloadMe()
    return true
  }

  func disconnectMicrosoft(_ service: MSService) async {
    guard !sessionId.isEmpty else { return }
    msNotes[service] = nil
    do {
      let me = try await api.msDisconnect(service: service, sessionId: sessionId)
      profile = me
      rememberSession(me.sessionId)
      msLocalDenied[service] = nil
      msErrors[service] = nil
      msBrowserPending[service] = nil
      paintConnections()
    } catch {
      msErrors[service] = (error as? APIError)?.message ?? "Could not disconnect \(service.title)."
      paintConnections()
    }
  }

  /// Asks the server to email school IT. If the Mac cannot send, opens the mailto draft instead.
  func requestConsent(_ service: MSService) async {
    guard !sessionId.isEmpty else { return }
    msNotes[service] = "Sending…"
    do {
      let reply = try await api.msConsentRequest(service: service, sessionId: sessionId)
      msConsent[service] = reply
      if reply.sent {
        msNotes[service] = reply.to.isEmpty ? "Request sent" : "Request sent to \(reply.to)"
        return
      }
      if let mailto = URL(string: reply.mailto), !reply.mailto.isEmpty {
        let opened = await UIApplication.shared.open(mailto)
        msNotes[service] = opened ? "Opened Mail" : "Mail did not open. Use Copy request."
        return
      }
      msNotes[service] = reply.body.isEmpty
        ? "Could not build the request. Use the admin approval link."
        : "Mail is not set up here. Use Copy request."
    } catch {
      msNotes[service] = (error as? APIError)?.message ?? "Could not send the request."
    }
  }

  /// Puts the IT request text on the clipboard. Fetches it first if we do not have it yet.
  func copyConsentRequest(_ service: MSService) async {
    var request = msConsent[service] ?? profile?.consentRequest
    if request == nil || request?.body.isEmpty == true, !sessionId.isEmpty {
      request = try? await api.msConsentRequest(service: service, sessionId: sessionId)
      if let request { msConsent[service] = request }
    }
    guard let request, !request.body.isEmpty else {
      msNotes[service] = "Nothing to copy yet."
      return
    }
    var text = request.body
    if !request.subject.isEmpty { text = "Subject: \(request.subject)\n\n\(text)" }
    if !request.to.isEmpty { text = "To: \(request.to)\n\(text)" }
    UIPasteboard.general.string = text
    msNotes[service] = "Copied"
  }

  func reloadMe() async {
    guard !sessionId.isEmpty else { return }
    do {
      let me = try await api.fetchMe(sessionId: sessionId)
      profile = me
      rememberSession(me.sessionId)
    } catch let error as APIError where error.status == 401 {
      profile = nil
    } catch {
      /* keep the profile we have; the pane keeps its last state */
    }
    paintConnections()
  }

  static func isMicrosoftCallback(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == msCallbackScheme else { return false }
    let host = (url.host ?? "").lowercased()
    if host == msCallbackHost { return true }
    return url.path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/")) == msCallbackHost
  }

  private func runBrowserSignIn(_ service: MSService, authorizeUrl: String) async {
    guard let url = URL(string: authorizeUrl) else {
      msBrowserPending[service] = nil
      msErrors[service] = "Microsoft sent a sign-in link the app could not open."
      paintConnections()
      return
    }
    authSession?.cancel()
    let callback: URL? = await withCheckedContinuation { continuation in
      var resumed = false
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.msCallbackScheme) { url, _ in
        guard !resumed else { return }
        resumed = true
        continuation.resume(returning: url)
      }
      session.prefersEphemeralWebBrowserSession = false
      session.presentationContextProvider = authPresenter
      authSession = session
      if !session.start() {
        guard !resumed else { return }
        resumed = true
        continuation.resume(returning: nil)
      }
    }
    authSession = nil

    if let callback {
      await handleMicrosoftCallback(callback)
      return
    }
    // Closed or cancelled. The server may still have finished if the redirect landed
    // outside the sheet, so check once before falling back to the Connect button.
    msBrowserPending[service] = nil
    await reloadMe()
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

  func removeKey(at index: Int) async {
    guard isSignedIn else { return }
    keyStatus = "Removing…"
    await persistAgent(removeIndex: index)
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

  private func persistAgent(
    modelKey: String? = nil,
    provider: String? = nil,
    clear: Bool = false,
    removeIndex: Int? = nil
  ) async {
    guard !sessionId.isEmpty else { return }
    do {
      let me: Profile = try await api.request(
        "/v1/me/agent",
        method: "POST",
        body: SaveAgentBody(
          provider: provider,
          modelKey: modelKey,
          clear: clear,
          removeIndex: removeIndex
        ),
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

  private func paintConnections() {
    guard let me = profile else {
      msStates = [:]
      msBrowserPending = [:]
      msLocalDenied = [:]
      msErrors = [:]
      msForcedOff = false
      return
    }
    if me.msConfigured == true, me.msClientMode.lowercased() != "off" {
      msForcedOff = false
    } else if me.isMicrosoftSignInOff {
      msForcedOff = true
    }
    var next: [MSService: MSPaneState] = [:]
    for service in MSService.allCases {
      next[service] = paneState(service, me: me)
    }
    msStates = next
  }

  private func paneState(_ service: MSService, me: Profile) -> MSPaneState {
    if me.msStudio(service) {
      return .studio(email: me.msEmail(service))
    }
    if me.msConnected(service) {
      return .connected(email: me.msEmail(service))
    }
    if msForcedOff || me.isMicrosoftSignInOff {
      return .off
    }
    if let error = msErrors[service], !error.isEmpty {
      return .error(error)
    }
    let profileReason = me.msDenied.reason(service)
    let local = msLocalDenied[service]
    if !profileReason.isEmpty || local != nil {
      // Displayed reason: status deniedReason, then msDenied.<service>, then a generic line.
      let reason = [local ?? "", profileReason].first { !$0.isEmpty } ?? Self.genericDenied
      return .denied(
        reason: reason,
        needsAdminApproval: me.msNeedsAdminApproval || Self.looksLikeAdminConsent(reason)
      )
    }
    if let pending = me.msPending(service), pending.isBrowser {
      return .pendingBrowser(authorizeUrl: pending.resolvedAuthorizeUrl)
    }
    if let authorizeUrl = msBrowserPending[service], !authorizeUrl.isEmpty {
      return .pendingBrowser(authorizeUrl: authorizeUrl)
    }
    return .idle
  }

  private static let genericDenied = "Microsoft denied this service for your sign-in."

  private static func looksLikeAdminConsent(_ reason: String) -> Bool {
    let folded = reason.lowercased()
    return folded.contains("admin") || folded.contains("approval") || folded.contains("consent")
      || folded.contains("aadsts65001") || folded.contains("aadsts90094") || folded.contains("aadsts900941")
  }

  private func refreshKeyStatus() {
    let count = profile?.modelKeyCount ?? 0
    if profile?.modelKeySet == true || !modelKey.isEmpty {
      if count > 1 {
        keyStatus = "Using \(count) \(provider) keys on this account. Chat switches if one hits its limit."
      } else {
        keyStatus = "Using your \(provider) key on this account"
      }
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

  private static func isGoogleCancel(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain.contains("GIDSignIn") && ns.code == -5 { return true }
    return error.localizedDescription.lowercased().contains("cancel")
  }
}

/// Hands ASWebAuthenticationSession the key window so the Microsoft sheet has somewhere to appear.
private final class MSAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
  }
}
