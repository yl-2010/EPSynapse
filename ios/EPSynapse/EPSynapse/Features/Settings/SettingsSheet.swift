import SwiftUI
import UniformTypeIdentifiers

private enum SettingsPane: String, Hashable {
    case schedule
    case chat
    case canvas
    case onedrive
    case onenote
    case outlook
    case teams

    var title: String {
        switch self {
        case .schedule: "Schedule"
        case .chat: "Chat key"
        case .canvas: "Canvas"
        case .onedrive: "OneDrive"
        case .onenote: "OneNote"
        case .outlook: "Outlook"
        case .teams: "Teams"
        }
    }

    var microsoftService: MSService? {
        switch self {
        case .onedrive: .onedrive
        case .onenote: .onenote
        case .outlook: .outlook
        case .teams: .teams
        default: nil
        }
    }
}

struct SettingsSheet: View {
    @Binding var isPresented: Bool
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    @State private var path: [SettingsPane] = []
    @State private var canvasHost = "https://eastsideprep.instructure.com"
    @State private var canvasToken = ""
    @State private var draftKey = ""
    @State private var pickingPDF = false
    @State private var pickedPDF: URL?
    @State private var replacingKey = false
    @State private var replacingCanvas = false

    private static let groqHelp = URL(string: "https://epsynapse.com/groq")!
    private static let canvasHelp = URL(string: "https://epsynapse.com/canvas")!

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            NavigationStack(path: $path) {
                rootList
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationDestination(for: SettingsPane.self) { pane in
                        paneScroll {
                            switch pane {
                            case .schedule: schedulePane
                            case .chat: chatPane
                            case .canvas: canvasPane
                            case .onedrive: microsoftPane(.onedrive)
                            case .onenote: microsoftPane(.onenote)
                            case .outlook: microsoftPane(.outlook)
                            case .teams: microsoftPane(.teams)
                            }
                        }
                        .toolbar(.hidden, for: .navigationBar)
                    }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(.ultraThinMaterial)
        .onAppear { hydrate() }
        .onChange(of: session.profile) { _, _ in hydrate() }
        .onChange(of: session.isSignedIn) { _, signedIn in
            if !signedIn { path = [] }
        }
        .onChange(of: session.provider) { old, new in
            guard old != new, session.isSignedIn else { return }
            Task { await session.saveProvider(new) }
        }
        .fileImporter(
            isPresented: $pickingPDF,
            allowedContentTypes: [.pdf],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                pickedPDF = Self.copiedPDF(urls.first)
                if pickedPDF != nil, dashboard.scheduleStatus.hasPrefix("Choose an EPS") {
                    dashboard.scheduleStatus = ""
                }
                if let url = pickedPDF {
                    Task {
                        await dashboard.uploadSchedule(fileURL: url, session: session)
                        if dashboard.scheduleStatus.hasPrefix("Schedule uploaded") {
                            await dashboard.load(from: session)
                        }
                    }
                }
            case .failure:
                dashboard.scheduleStatus = "Could not open that PDF."
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            if !path.isEmpty {
                Button {
                    path.removeLast()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(EPSTheme.fg)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .epsSizedGlassCircle(side: 28)
                .accessibilityLabel("Back")
            }
            Text(path.last?.title ?? "Settings")
                .font(.title3.weight(.bold))
                .foregroundStyle(EPSTheme.fg)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(EPSTheme.accent)
                        .frame(width: 3)
                }
            Spacer()
            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(EPSTheme.fg)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .epsSizedGlassCircle(side: 28)
            .accessibilityLabel("Close settings")
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    private var rootList: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                googleAccountBlock
                Text(statusCopy)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                if session.isSignedIn {
                    VStack(spacing: 8) {
                        navRow(.schedule, meta: scheduleMeta)
                        navRow(.chat, meta: chatMeta)
                        navRow(.canvas, meta: canvasMeta)
                        navRow(.onedrive, meta: onedriveMeta)
                        navRow(.onenote, meta: onenoteMeta)
                        navRow(.outlook, meta: outlookMeta)
                        navRow(.teams, meta: teamsMeta)
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: AdaptiveLayout.formMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .epsVerticalScrollOnly()
    }

    private func paneScroll<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView(.vertical) {
            content()
                .frame(maxWidth: AdaptiveLayout.formMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .epsVerticalScrollOnly()
    }

    private func navRow(_ pane: SettingsPane, meta: String) -> some View {
        Button {
            path.append(pane)
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pane.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(EPSTheme.muted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, interactive: true)
        .epsHapticNavigation()
        .accessibilityHint(meta)
    }

    private var schedulePane: some View {
        VStack(alignment: .leading, spacing: 12) {
            fieldLabel("four11 schedule")
            Text("Upload this trimester's four11 schedule so your classes and grades can line up. Use the printed term card with periods A-H from after the latest add/drop, the same classes you have in Canvas right now. EPSynapse syncs schedule, classes, and grades with Canvas, so the PDF you add has to match.")
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
                .fixedSize(horizontal: false, vertical: true)

            if let name = pickedPDF?.lastPathComponent, !name.isEmpty {
                Text(name)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.fg)
            }
            goldButton(dashboard.scheduleBusy ? "Uploading…" : "Upload four11 schedule") {
                pickingPDF = true
            }
            if !dashboard.scheduleStatus.isEmpty {
                Text(dashboard.scheduleStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
        }
    }

    private var chatPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            if isCursorAgent {
                Text("Cursor")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                Text("This account uses Cursor on the Mac. No Groq key.")
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            } else if !hasChatKey || replacingKey {
                stepList(Self.chatSteps)
            }

            if hasChatKey && !isCursorAgent {
                HStack(alignment: .center, spacing: 12) {
                    Text(chatKeyTitle)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    Spacer(minLength: 8)
                    textAction("Add another") { replacingKey = true }
                    textAction("Clear all") {
                        Task {
                            await session.clearKey()
                            draftKey = ""
                            replacingKey = false
                        }
                    }
                }
                ForEach(Array(chatKeyHints.enumerated()), id: \.offset) { index, hint in
                    HStack(alignment: .center, spacing: 12) {
                        Text("••••\(hint)")
                            .font(.body)
                            .foregroundStyle(EPSTheme.fg)
                        Spacer(minLength: 8)
                        textAction("Remove") {
                            Task { await session.removeKey(at: index) }
                        }
                    }
                }
            }

            if !isCursorAgent && (!hasChatKey || replacingKey) {
                fieldLabel("Model")
                glassField {
                    Picker("Model", selection: $session.provider) {
                        ForEach(session.providers) { provider in
                            Text(provider.recommended ? "\(provider.label) · recommended" : provider.label)
                                .tag(provider.id)
                        }
                    }
                    .labelsHidden()
                    .tint(EPSTheme.fg)
                }

                fieldLabel("API key")
                glassField {
                    SecureField("gsk_…", text: $draftKey)
                }

                goldButton("Save key") {
                    Task {
                        await session.saveKey(draftKey)
                        if session.profile?.modelKeySet == true {
                            draftKey = ""
                            replacingKey = false
                        }
                    }
                }
            }

            if !chatStatusCopy.isEmpty {
                Text(chatStatusCopy)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
            if !isCursorAgent {
                helpLink("How to get a Groq key", Self.groqHelp)
            }
        }
    }

    private var canvasPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            if session.profile?.canvasConnected != true || replacingCanvas {
                stepList(Self.canvasSteps)
            }

            fieldLabel("Canvas URL")
            glassField {
                TextField("https://eastsideprep.instructure.com", text: $canvasHost)
            }

            if session.profile?.canvasConnected == true {
                HStack(alignment: .center, spacing: 12) {
                    Text("Canvas connected")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    Spacer(minLength: 8)
                    textAction("Replace token") { replacingCanvas = true }
                }
            }

            if session.profile?.canvasConnected != true || replacingCanvas {
                fieldLabel("Access token")
                glassField {
                    SecureField("Token", text: $canvasToken)
                }
            }

            goldButton("Save") {
                Task { await saveCanvas() }
            }
            if !session.settingsStatus.isEmpty {
                Text(session.settingsStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
            helpLink("How to get a Canvas token", Self.canvasHelp)
        }
    }

    @ViewBuilder
    private func microsoftPane(_ pane: SettingsPane) -> some View {
        if let service = pane.microsoftService {
            microsoftServicePane(service)
        }
    }

    @ViewBuilder
    private func microsoftServicePane(_ service: MSService) -> some View {
        let state = session.msState(service)
        let note = session.msNotes[service] ?? ""
        let consentURL = session.adminConsentURL(for: service)

        VStack(alignment: .leading, spacing: 12) {
            if !state.isConnected, !state.isOff {
                stepList(Self.microsoftSteps(for: service))
            }

            switch state {
            case .connected(let email):
                HStack(alignment: .center, spacing: 12) {
                    Text("\(service.title) connected")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    Spacer(minLength: 8)
                    textAction("Disconnect") {
                        Task { await session.disconnectMicrosoft(service) }
                    }
                }
                if !email.isEmpty {
                    Text(email)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                }

            case .studio(let email):
                Text("\(service.title) connected")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                Text(email.isEmpty ? "\(service.title) connected" : "\(service.title) · \(email)")
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)

            case .denied(let reason, let needsAdminApproval):
                Text(needsAdminApproval ? "Approval required" : "Microsoft said no")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                if !reason.isEmpty {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                Text("Microsoft needs school IT to approve EPSynapse once. After that every EPS student can connect.")
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                goldButton("Send request to school IT") {
                    Task { await session.requestConsent(service) }
                }
                HStack(alignment: .center, spacing: 16) {
                    textAction("Copy request") {
                        Task { await session.copyConsentRequest(service) }
                    }
                    textAction("Connect again") {
                        Task { await session.connectMicrosoft(service) }
                    }
                }
                if let consentURL {
                    helpLink("Admin approval link", consentURL)
                }

            case .pendingBrowser:
                Text("Finish the school sign-in in the Microsoft window, then come back here.")
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                goldButton("Connect \(service.title)") {
                    Task { await session.connectMicrosoft(service) }
                }

            case .off:
                Text(Self.microsoftOffCopy)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                goldButton("Connect \(service.title)") {}
                    .disabled(true)
                    .opacity(0.45)

            case .error(let message):
                goldButton("Connect \(service.title)") {
                    Task { await session.connectMicrosoft(service) }
                }
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

            case .idle:
                goldButton("Connect \(service.title)") {
                    Task { await session.connectMicrosoft(service) }
                }
            }

            if !note.isEmpty {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let consentURL, !state.isConnected, !state.isOff, !isDenied(state) {
                helpLink("Admin approval link", consentURL)
            }
        }
    }

    private func isDenied(_ state: MSPaneState) -> Bool {
        if case .denied = state { return true }
        return false
    }

    @ViewBuilder
    private var googleAccountBlock: some View {
        if session.isSignedIn, let profile = session.profile {
            HStack(alignment: .center, spacing: 12) {
                googlePicture(profile.picture)
                VStack(alignment: .leading, spacing: 2) {
                    if !profile.signedInName.isEmpty {
                        Text(profile.signedInName)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(EPSTheme.fg)
                    }
                    if !profile.email.isEmpty {
                        Text(profile.email)
                            .font(.footnote)
                            .foregroundStyle(EPSTheme.muted)
                    }
                }
                Spacer(minLength: 8)
                textAction("Sign out") {
                    Task { await session.logout() }
                }
            }
        } else {
            goldButton("Sign in with Google") {
                Task { await session.signInWithGoogle() }
            }
        }
    }

    @ViewBuilder
    private func googlePicture(_ raw: String) -> some View {
        if let url = URL(string: raw), !raw.isEmpty {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                default:
                    Circle().fill(EPSTheme.accent.opacity(0.35))
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
        }
    }

    private func stepList(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(index + 1).")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(EPSTheme.muted)
                        .frame(width: 18, alignment: .trailing)
                    Text(LocalizedStringKey(line))
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.fg)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(EPSTheme.muted)
    }

    private func glassField<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .font(.body)
            .foregroundStyle(EPSTheme.fg)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .epsGlassField(interactive: true, cornerRadius: 14)
    }

    private func goldButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(goldLabel)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
        .epsHapticOnTap()
    }

    private func textAction(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(EPSTheme.fg)
        }
        .buttonStyle(.plain)
        .epsHapticOnTap()
    }

    private func helpLink(_ title: String, _ url: URL) -> some View {
        Link(title, destination: url)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(EPSTheme.accent)
    }

    private var goldLabel: Color {
        colorScheme == .dark ? Color.white : Color(red: 11 / 255, green: 31 / 255, blue: 58 / 255)
    }

    private var statusCopy: String {
        if !session.settingsStatus.isEmpty { return session.settingsStatus }
        if session.isSignedIn { return SessionStore.signedInHint }
        return SessionStore.googleFirst
    }

    private var scheduleMeta: String {
        if dashboard.scheduleBusy { return "Uploading" }
        return dashboard.scheduleClasses.isEmpty ? "Upload your four11 PDF" : "Uploaded"
    }

    private var isCursorAgent: Bool {
        session.profile?.modelProvider == "cursor"
    }

    private var chatMeta: String {
        if isCursorAgent { return "Cursor" }
        guard hasChatKey else { return "Add a Groq key" }
        if chatKeyCount > 1 { return "\(providerLabel) · \(chatKeyCount) keys" }
        return providerLabel
    }

    private var canvasMeta: String {
        session.profile?.canvasConnected == true ? "Connected" : "URL and token"
    }

    private var onedriveMeta: String { msMeta(.onedrive) }
    private var onenoteMeta: String { msMeta(.onenote) }
    private var outlookMeta: String { msMeta(.outlook) }
    private var teamsMeta: String { msMeta(.teams) }

    private func msMeta(_ service: MSService) -> String {
        switch session.msState(service) {
        case .connected(let email), .studio(let email):
            let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "Connected" : trimmed
        case .denied(_, let needsAdminApproval):
            return needsAdminApproval ? "Needs IT approval" : "Not connected"
        case .pendingBrowser:
            return "Finishing sign-in"
        case .off:
            return "Off"
        case .idle, .error:
            return "Not connected"
        }
    }

    private var hasChatKey: Bool {
        session.profile?.modelKeySet == true || !session.modelKey.isEmpty
    }

    private var providerLabel: String {
        if let label = session.providers.first(where: { $0.id == session.provider })?.label, !label.isEmpty {
            return label
        }
        if isCursorAgent { return "Cursor" }
        switch session.provider {
        case "groq": return "Groq"
        case "gemini": return "Gemini"
        case "openrouter": return "OpenRouter"
        case "cursor": return "Cursor"
        default: return session.provider.isEmpty ? "Groq" : session.provider
        }
    }

    private var chatStatusCopy: String {
        if replacingKey { return "Paste another key. Chat will use the next one if this one hits its limit." }
        if hasChatKey { return "" }
        return session.keyStatus
    }

    private var chatKeyCount: Int {
        let count = session.profile?.modelKeyCount ?? 0
        if count > 0 { return count }
        return hasChatKey ? 1 : 0
    }

    private var chatKeyTitle: String {
        chatKeyCount > 1 ? "\(providerLabel) · \(chatKeyCount) keys" : providerLabel
    }

    private var chatKeyHints: [String] {
        let hints = session.profile?.modelKeyHints ?? []
        if !hints.isEmpty { return hints }
        let hint = session.profile?.modelKeyHint ?? ""
        return hint.isEmpty ? [] : [hint]
    }

    private func saveCanvas() async {
        await session.saveCanvas(canvasHost: canvasHost, canvasToken: canvasToken)
        if session.settingsStatus.hasPrefix("Saved") {
            canvasToken = ""
            replacingCanvas = false
            await dashboard.load(from: session)
        }
    }

    private func hydrate() {
        if let profile = session.profile, !profile.canvasHost.isEmpty {
            canvasHost = profile.canvasHost
        }
        draftKey = ""
    }

    private static let chatSteps = [
        "Sign in with Google on this page if you have not already.",
        "Get a free Groq key at [console.groq.com/keys](https://console.groq.com/keys). Sign up with Google. No credit card. Create API Key, then copy the value that starts with gsk_. Groq shows it only once.",
        "Paste it in the API key field below. Leave Model on Groq.",
        "Tap Save key. Enter also saves. Do not use the Canvas Save button for this.",
        "You can save more than one key. Chat switches if a key hits its free limit.",
        "Chat key on the settings list must say Groq. Then close settings and ask in the chat pill. Do not paste the key in chat.",
    ]

    private static let canvasSteps = [
        "Sign in with Google on this page if you have not already.",
        "Open [eastsideprep.instructure.com](https://eastsideprep.instructure.com). If you see four11, tap @eastsideprep.org login. Sign in with your school Microsoft account. Not Parent/Guardian.",
        "In Canvas, click Account (your picture, left side), then Settings. Scroll to Approved Integrations. Click Add New Access Token.",
        "Purpose: EPSynapse. Students must pick an expiration date. There is no permissions list. Click Generate Token and copy it now. Canvas shows it once.",
        "Leave Canvas URL as https://eastsideprep.instructure.com unless you use another school. Paste the token below. Tap Save.",
        "Canvas on the settings list must say Connected. Then close settings.",
    ]

    private static let microsoftOffCopy =
        "Microsoft sign-in is off. EPSynapse needs its own Microsoft app registration approved by school IT before this can connect."

    private static func microsoftSteps(for service: MSService) -> [String] {
        let noun: String = switch service {
        case .onedrive: "files"
        case .onenote: "notebooks"
        case .outlook: "mail"
        case .teams: "chats"
        }
        return [
            "Sign in with Google on this page if you have not already.",
            "Tap Connect. Microsoft opens a school sign-in. Use your @eastsideprep.org account.",
            "If Microsoft says Approval required, come back and tap Send request to school IT.",
            "Once IT approves, tap Connect again. Connected only appears after EPSynapse can actually read your \(service.title) \(noun).",
        ]
    }

    private static func copiedPDF(_ url: URL?) -> URL? {
        guard let url else { return nil }
        let accessed = url.startAccessingSecurityScopedResource()
        defer {
            if accessed { url.stopAccessingSecurityScopedResource() }
        }
        let original = url.lastPathComponent.isEmpty ? "schedule.pdf" : url.lastPathComponent
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("eps-\(UUID().uuidString)-\(original)")
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.copyItem(at: url, to: dest)
            return dest
        } catch {
            return url
        }
    }
}
