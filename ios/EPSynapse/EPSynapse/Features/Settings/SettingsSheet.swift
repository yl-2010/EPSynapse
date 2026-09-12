import SwiftUI

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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                statusLine

                fieldLabel("School")
                glassField { TextField("Eastside Prep", text: $school) }

                fieldLabel("Student ID")
                glassField { TextField("Required", text: $studentId) }

                fieldLabel("Canvas URL")
                glassField { TextField("https://eastsideprep.instructure.com", text: $canvasHost) }

                fieldLabel("Canvas access token")
                glassField { SecureField("Token", text: $canvasToken) }
                Text("Account → Settings → New Access Token")
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)

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

                actionRow {
                    glassAction("Connect OneDrive") {
                        Task { await session.startOnedrive() }
                    }
                }
                Text(session.onedriveStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                deviceCode(session.odCode, uri: session.odURI)

                actionRow {
                    glassAction("Connect Outlook") {
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

                fieldLabel("Model key (stays on this device)")
                glassField {
                    SecureField("Groq / Gemini / OpenRouter", text: $draftKey)
                }

                HStack(spacing: 8) {
                    goldButton("Save key") {
                        session.saveKey(draftKey)
                        if !draftKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            draftKey = ""
                        }
                    }
                    glassAction("Clear key") {
                        session.clearKey()
                        draftKey = ""
                    }
                }
                Text(session.keyStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
            .padding(20)
            .frame(maxWidth: AdaptiveLayout.formMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .presentationDetents([.large])
        .presentationBackground(.ultraThinMaterial)
        .onAppear { hydrate() }
        .task(id: isPresented) {
            guard isPresented else { return }
            while !Task.isCancelled, isPresented {
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
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(EPSTheme.accent.opacity(0.38))
                .frame(height: 1)
        }
    }

    private var statusLine: some View {
        Text(
            session.settingsStatus.isEmpty
                ? "School + student ID is your record. Honor system for the hackathon."
                : session.settingsStatus
        )
        .font(.footnote)
        .foregroundStyle(EPSTheme.muted)
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
}
