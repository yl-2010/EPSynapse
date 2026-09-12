import SwiftUI
import UniformTypeIdentifiers

private enum SettingsPane: String, Hashable {
    case school
    case chat
    case canvas
    case onedrive
    case onenote
    case outlook
    case teams

    var title: String {
        switch self {
        case .school: "School"
        case .chat: "Chat key"
        case .canvas: "Canvas"
        case .onedrive: "OneDrive"
        case .onenote: "OneNote"
        case .outlook: "Outlook"
        case .teams: "Teams"
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
    @State private var school = "Eastside Prep"
    @State private var studentId = ""
    @State private var canvasHost = "https://eastsideprep.instructure.com"
    @State private var canvasToken = ""
    @State private var draftKey = ""
    @State private var schoolHits: [SchoolHit] = []
    @State private var pickingPDF = false
    @State private var pickedPDF: URL?
    @State private var replacingKey = false
    @State private var replacingCanvas = false

    private static let adminConsent = URL(
        string: "https://login.microsoftonline.com/b2681e8b-dd20-46cf-b163-371a2d7c6014/v2.0/adminconsent?client_id=d3590ed6-52b3-4102-aeff-aad2292ab01c&scope=https://graph.microsoft.com/.default&redirect_uri=https://epsynapse.com/"
    )!
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
                            case .school: schoolPane
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
        .task(id: school) {
            guard session.isSignedIn else { return }
            try? await Task.sleep(nanoseconds: 280_000_000)
            guard !Task.isCancelled else { return }
            let hits = await session.searchSchools(query: school)
            if hits.count == 1, hits[0].name.caseInsensitiveCompare(school) == .orderedSame {
                schoolHits = []
            } else {
                schoolHits = hits
            }
        }
        .task {
            while !Task.isCancelled {
                if hasMicrosoftPending {
                    await session.pollConnections()
                }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
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
                        navRow(.school, meta: schoolMeta)
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

    private var schoolPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            fieldLabel("School")
            glassField { TextField("Eastside Prep", text: $school) }
            schoolSuggestions

            fieldLabel("Student ID")
            glassField { TextField("Optional", text: $studentId) }

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

            goldButton("Save") {
                Task { await saveSchool() }
            }
            if !session.settingsStatus.isEmpty {
                Text(session.settingsStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
        }
    }

    private var chatPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !hasChatKey || replacingKey {
                stepList(Self.chatSteps)
            }

            if hasChatKey {
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

            if !hasChatKey || replacingKey {
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
            helpLink("How to get a Groq key", Self.groqHelp)
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
        let connected: Bool = {
            switch pane {
            case .onedrive, .onenote: session.profile?.onedriveConnected == true
            case .outlook: session.profile?.outlookConnected == true
            case .teams: session.profile?.teamsConnected == true
            default: false
            }
        }()
        let email: String = {
            switch pane {
            case .onedrive, .onenote: session.profile?.onedriveEmail ?? ""
            case .outlook: session.profile?.outlookEmail ?? ""
            case .teams: session.profile?.teamsEmail ?? ""
            default: ""
            }
        }()
        let code: String = {
            switch pane {
            case .onedrive, .onenote: session.odCode
            case .outlook: session.olCode
            case .teams: session.tmCode
            default: ""
            }
        }()
        let uri: String = {
            switch pane {
            case .onedrive, .onenote: session.odURI
            case .outlook: session.olURI
            case .teams: session.tmURI
            default: ""
            }
        }()
        let status: String = {
            switch pane {
            case .onedrive, .onenote: session.onedriveStatus
            case .outlook: session.outlookStatus
            case .teams: session.teamsStatus
            default: ""
            }
        }()
        let pending = !code.isEmpty || !uri.isEmpty

        VStack(alignment: .leading, spacing: 12) {
            if !connected {
                stepList(Self.microsoftSteps(for: pane))
            }

            if connected {
                Text("\(pane.title) connected")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                if !email.isEmpty {
                    Text(email)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                }
            } else if !pending {
                goldButton("Connect \(pane.title)") {
                    Task { await startMicrosoft(pane) }
                }
            }

            if pending {
                if !code.isEmpty {
                    Text(code)
                        .font(.title2.weight(.bold).monospaced())
                        .foregroundStyle(EPSTheme.fg)
                        .textSelection(.enabled)
                }
                if let url = URL(string: uri), !uri.isEmpty {
                    helpLink("Open Microsoft sign-in", url)
                }
            }

            if !status.isEmpty {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
            helpLink("Ask school IT to approve", Self.adminConsent)
        }
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
    private var schoolSuggestions: some View {
        if !schoolHits.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(schoolHits.prefix(8)) { hit in
                    Button {
                        school = hit.name
                        if !hit.canvasHost.isEmpty {
                            canvasHost = Self.normalizedCanvasHost(hit.canvasHost)
                        }
                        schoolHits = []
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.name)
                                .font(.body)
                                .foregroundStyle(EPSTheme.fg)
                            if !hit.shortName.isEmpty, hit.shortName != hit.name {
                                Text(hit.shortName)
                                    .font(.caption)
                                    .foregroundStyle(EPSTheme.muted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                }
            }
            .epsGlassField(interactive: false, cornerRadius: 14)
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

    private var schoolMeta: String {
        let name = school.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        let saved = session.profile?.school.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return saved.isEmpty ? "Eastside Prep" : saved
    }

    private var chatMeta: String {
        guard hasChatKey else { return "Add a Groq key" }
        if chatKeyCount > 1 { return "\(providerLabel) · \(chatKeyCount) keys" }
        return providerLabel
    }

    private var canvasMeta: String {
        session.profile?.canvasConnected == true ? "Connected" : "URL and token"
    }

    private var onedriveMeta: String {
        msMeta(connected: session.profile?.onedriveConnected == true, email: session.profile?.onedriveEmail ?? "", fallback: "School files")
    }

    private var onenoteMeta: String {
        msMeta(connected: session.profile?.onedriveConnected == true, email: session.profile?.onedriveEmail ?? "", fallback: "School notebooks")
    }

    private var outlookMeta: String {
        msMeta(connected: session.profile?.outlookConnected == true, email: session.profile?.outlookEmail ?? "", fallback: "School mail")
    }

    private var teamsMeta: String {
        msMeta(connected: session.profile?.teamsConnected == true, email: session.profile?.teamsEmail ?? "", fallback: "School chat")
    }

    private func msMeta(connected: Bool, email: String, fallback: String) -> String {
        if connected {
            let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "Connected" : trimmed
        }
        return fallback
    }

    private var hasChatKey: Bool {
        session.profile?.modelKeySet == true || !session.modelKey.isEmpty
    }

    private var providerLabel: String {
        if let label = session.providers.first(where: { $0.id == session.provider })?.label, !label.isEmpty {
            return label
        }
        switch session.provider {
        case "groq": return "Groq"
        case "gemini": return "Gemini"
        case "openrouter": return "OpenRouter"
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

    private var hasMicrosoftPending: Bool {
        session.profile?.onedrivePending?.isActive == true
            || session.profile?.outlookPending?.isActive == true
            || session.profile?.teamsPending?.isActive == true
            || !session.odCode.isEmpty
            || !session.olCode.isEmpty
            || !session.tmCode.isEmpty
    }

    private func saveSchool() async {
        await session.save(
            school: school,
            studentId: studentId,
            canvasHost: canvasHost,
            canvasToken: ""
        )
        if session.settingsStatus.hasPrefix("Saved") {
            await dashboard.load(from: session)
        }
    }

    private func saveCanvas() async {
        await session.save(
            school: school,
            studentId: studentId,
            canvasHost: canvasHost,
            canvasToken: canvasToken
        )
        if session.settingsStatus.hasPrefix("Saved") {
            canvasToken = ""
            replacingCanvas = false
            await dashboard.load(from: session)
        }
    }

    private func startMicrosoft(_ pane: SettingsPane) async {
        switch pane {
        case .onedrive, .onenote:
            await session.startOnedrive()
            openPending(session.odURI)
        case .outlook:
            await session.startOutlook()
            openPending(session.olURI)
        case .teams:
            await session.startTeams()
            openPending(session.tmURI)
        default:
            break
        }
    }

    private func openPending(_ raw: String) {
        guard let url = URL(string: raw), !raw.isEmpty else { return }
        openURL(url)
    }

    private func hydrate() {
        if let profile = session.profile {
            if !profile.school.isEmpty { school = profile.school }
            studentId = profile.studentId
            if !profile.canvasHost.isEmpty { canvasHost = profile.canvasHost }
        }
        draftKey = ""
    }

    private static let chatSteps = [
        "Sign in with Google on this page if you have not already.",
        "Get a free Groq key at [console.groq.com/keys](https://console.groq.com/keys). Sign up with Google. No credit card. Create API Key, then copy the value that starts with gsk_. Groq shows it only once.",
        "Paste it in the API key field below. Leave Model on Groq.",
        "Tap Save key. Enter also saves. Do not use the School Save button for this.",
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

    private static func microsoftSteps(for pane: SettingsPane) -> [String] {
        let last = pane == .onenote
            ? "OneNote uses the OneDrive Microsoft sign-in. OneNote on the settings list must say Connected."
            : "\(pane.title) on the settings list must say Connected."
        return [
            "Sign in with Google on this page if you have not already.",
            "Tap Connect \(pane.title). Microsoft opens a school sign-in.",
            "Use your @eastsideprep.org account. If Microsoft says the app needs admin approval, that is expected. School IT Accepts once, then every student can connect.",
            last,
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

    private static func normalizedCanvasHost(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        return "https://\(trimmed)"
    }
}
