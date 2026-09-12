import SwiftUI
import UniformTypeIdentifiers

struct SettingsSheet: View {
    @Binding var isPresented: Bool
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    @State private var school = "Eastside Prep"
    @State private var studentId = ""
    @State private var canvasHost = "https://eastsideprep.instructure.com"
    @State private var canvasToken = ""
    @State private var draftKey = ""
    @State private var schoolHits: [SchoolHit] = []
    @State private var pickingPDF = false
    @State private var pickedPDF: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    statusLine
                    accountSection
                    if session.isSignedIn {
                        microsoftSection
                        agentSection
                    }
                }
                .padding(20)
                .frame(maxWidth: AdaptiveLayout.formMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .presentationDetents([.large])
        .presentationBackground(.ultraThinMaterial)
        .onAppear { hydrate() }
        .onChange(of: session.profile) { _, _ in hydrate() }
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
            case .failure:
                dashboard.scheduleStatus = "Could not open that PDF."
            }
        }
        .task(id: isPresented) {
            guard isPresented, session.isSignedIn else { return }
            while !Task.isCancelled, isPresented, session.isSignedIn {
                let od = session.profile?.onedriveConnected
                let ol = session.profile?.outlookConnected
                await session.pollConnections()
                if session.profile?.onedriveConnected != od || session.profile?.outlookConnected != ol {
                    await dashboard.load(from: session)
                }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Settings")
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

    private var statusLine: some View {
        Text(statusCopy)
            .font(.footnote)
            .foregroundStyle(EPSTheme.muted)
    }

    private var statusCopy: String {
        if !session.settingsStatus.isEmpty { return session.settingsStatus }
        if session.isSignedIn {
            return SessionStore.signedInHint
        }
        return "Sign in with Google. School and student ID let us match you at school."
    }

    private var accountSection: some View {
        settingsGroup("Account") {
            googleAccountBlock

            if session.isSignedIn {
                fieldLabel("School")
                glassField { TextField("Eastside Prep", text: $school) }
                schoolSuggestions

                fieldLabel("Student ID")
                glassField { TextField("Optional", text: $studentId) }

                fieldLabel("Canvas URL")
                glassField { TextField("https://eastsideprep.instructure.com", text: $canvasHost) }

                fieldLabel("Canvas access token")
                glassField { SecureField("Token", text: $canvasToken) }
                Text("Account → Settings → New Access Token")
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)

                fieldLabel("EPS schedule PDF")
                if let name = pickedPDF?.lastPathComponent, !name.isEmpty {
                    Text(name)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.fg)
                }
                HStack(spacing: 8) {
                    glassAction("Choose PDF") {
                        pickingPDF = true
                    }
                    goldButton(dashboard.scheduleBusy ? "Uploading…" : "Upload schedule") {
                        guard let url = pickedPDF else {
                            dashboard.scheduleStatus = "Choose an EPS schedule PDF first."
                            return
                        }
                        Task {
                            await dashboard.uploadSchedule(fileURL: url, session: session)
                            if dashboard.scheduleStatus.hasPrefix("Schedule uploaded") {
                                await dashboard.load(from: session)
                            }
                        }
                    }
                }
                if !dashboard.scheduleStatus.isEmpty {
                    Text(dashboard.scheduleStatus)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                }

                goldButton("Save") {
                    Task {
                        await session.save(
                            school: school,
                            studentId: studentId,
                            canvasHost: canvasHost,
                            canvasToken: canvasToken
                        )
                        if session.settingsStatus.hasPrefix("Saved") {
                            canvasToken = ""
                            await dashboard.load(from: session)
                            isPresented = false
                        }
                    }
                }
            }
        }
    }

    private var microsoftSection: some View {
        settingsGroup("Microsoft") {
            fieldLabel("OneDrive")
            actionRow {
                glassAction(session.profile?.onedriveConnected == true ? "Reconnect OneDrive" : "Connect OneDrive") {
                    Task { await session.startOnedrive() }
                }
            }
            Text(session.onedriveStatus)
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
            deviceCode(session.odCode, uri: session.odURI)

            fieldLabel("Outlook")
                .padding(.top, 6)
            actionRow {
                glassAction(session.profile?.outlookConnected == true ? "Reconnect Outlook" : "Connect Outlook") {
                    Task {
                        await session.startOutlook()
                        openDeviceURI(session.olURI)
                    }
                }
            }
            Text(session.outlookStatus)
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
            deviceCode(session.olCode, uri: session.olURI)
        }
    }

    private var agentSection: some View {
        settingsGroup("Agent") {
            if session.profile?.modelKeySet != true, session.modelKey.isEmpty {
                Text(SessionStore.setupGuide)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 6)
            }
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

            fieldLabel("Model key (this account)")
            glassField {
                SecureField("Groq / Gemini / OpenRouter", text: $draftKey)
            }

            HStack(spacing: 8) {
                goldButton("Save key") {
                    Task {
                        await session.saveKey(draftKey)
                        if session.profile?.modelKeySet == true {
                            draftKey = ""
                        }
                    }
                }
                glassAction("Clear key") {
                    Task {
                        await session.clearKey()
                        draftKey = ""
                    }
                }
            }
            Text(session.keyStatus)
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
        }
    }

    private func settingsGroup<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(EPSTheme.fg)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(EPSTheme.accent)
                        .frame(width: 3)
                }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                Spacer(minLength: 0)
            }
            glassAction("Sign out") {
                Task { await session.logout() }
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

    private func glassAction(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(EPSTheme.fg)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, interactive: true)
        .epsHapticOnTap()
    }

    private func actionRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        HStack { content(); Spacer(minLength: 0) }
    }

    @ViewBuilder
    private func deviceCode(_ code: String, uri: String) -> some View {
        if !code.isEmpty {
            Text(code)
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(EPSTheme.accent)
                .tracking(3.2)
                .padding(.top, 2)
        }
        if let url = URL(string: uri), !uri.isEmpty {
            Link("Open Microsoft sign-in", destination: url)
                .font(.footnote)
                .foregroundStyle(EPSTheme.muted)
        }
    }

    private var goldLabel: Color {
        colorScheme == .dark ? Color.white : Color(red: 11 / 255, green: 31 / 255, blue: 58 / 255)
    }

    private func openDeviceURI(_ raw: String) {
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
