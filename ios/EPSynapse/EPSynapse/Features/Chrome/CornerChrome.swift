import SwiftUI

extension Notification.Name {
    static let epsOpenSettings = Notification.Name("eps.openSettings")
    static let epsScrollHomeToTop = Notification.Name("eps.scrollHomeToTop")
}

/// Logo, theme orb, settings, and chat pill.
struct CornerChrome: View {
    @EnvironmentObject private var theme: ThemeStore

    private var orbSide: CGFloat { AdaptiveLayout.isPad ? 60 : 52 }
    private var cornerPad: CGFloat { AdaptiveLayout.isPad ? 20 : 16 }

    var body: some View {
        ZStack {
            VStack {
                HStack(alignment: .top) {
                    logoButton
                    Spacer(minLength: 0)
                        .allowsHitTesting(false)
                    themeOrb
                }
                Spacer(minLength: 0)
                    .allowsHitTesting(false)
            }
            .padding(cornerPad)
            .safeAreaPadding(.top)
            .safeAreaPadding(.horizontal)
            .ignoresSafeArea(.keyboard, edges: .bottom)

            VStack {
                Spacer(minLength: 0)
                    .allowsHitTesting(false)
                HStack(alignment: .bottom) {
                    settingsButton
                    Spacer(minLength: 0)
                        .allowsHitTesting(false)
                }
            }
            .padding(cornerPad)
            .safeAreaPadding(.bottom)
            .safeAreaPadding(.horizontal)
            .ignoresSafeArea(.keyboard, edges: .bottom)

            VStack {
                Spacer(minLength: 0)
                    .allowsHitTesting(false)
                HStack(alignment: .bottom) {
                    Spacer(minLength: 0)
                        .allowsHitTesting(false)
                    ChatOverlay()
                }
            }
            .padding(cornerPad)
            .safeAreaPadding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var logoButton: some View {
        Button {
            EPSHaptics.tap()
            NotificationCenter.default.post(name: .epsScrollHomeToTop, object: nil)
        } label: {
            EPSMark()
                .fill(EPSTheme.accent)
                .frame(width: orbSide * 0.46, height: orbSide * 0.46)
                .frame(width: orbSide, height: orbSide)
                .contentShape(RoundedRectangle(cornerRadius: orbSide * 0.4, style: .continuous))
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: orbSide * 0.4, interactive: true)
        .accessibilityLabel("EPSynapse")
    }

    private var settingsButton: some View {
        Button {
            EPSHaptics.tap()
            NotificationCenter.default.post(name: .epsOpenSettings, object: nil)
        } label: {
            Image(systemName: "gearshape.fill")
                .font(.system(size: orbSide * 0.38, weight: .semibold))
                .foregroundStyle(EPSTheme.fg)
                .frame(width: orbSide, height: orbSide)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .epsSizedGlassCircle(side: orbSide)
        .accessibilityLabel("Open settings")
    }

    private var themeOrb: some View {
        Button {
            EPSHaptics.medium()
            theme.cycle()
        } label: {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            EPSTheme.accent,
                            EPSTheme.accent.opacity(0.75),
                            Color(red: 11 / 255, green: 31 / 255, blue: 58 / 255),
                        ],
                        center: .topLeading,
                        startRadius: 2,
                        endRadius: orbSide * 0.74
                    )
                )
                .overlay {
                    Circle().strokeBorder(Color.white.opacity(0.28), lineWidth: 0.6)
                }
                .frame(width: orbSide, height: orbSide)
        }
        .buttonStyle(.plain)
        .epsSizedGlassCircle(side: orbSide)
        .accessibilityLabel("Cycle theme")
    }
}
