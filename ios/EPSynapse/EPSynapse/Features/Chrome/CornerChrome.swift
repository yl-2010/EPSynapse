import SwiftUI

extension Notification.Name {
    static let epsOpenSettings = Notification.Name("eps.openSettings")
    static let epsScrollHomeToTop = Notification.Name("eps.scrollHomeToTop")
}

/// Logo, theme orb, settings, and chat pill.
struct CornerChrome: View {
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var chat: ChatStore

    private var orbSide: CGFloat { AdaptiveLayout.cornerOrbSide }
    private var cornerPad: CGFloat { AdaptiveLayout.cornerPad }

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

            if session.isSignedIn {
                VStack {
                    Spacer(minLength: 0)
                        .allowsHitTesting(false)
                    HStack(alignment: .bottom) {
                        if !chat.composerOpen {
                            settingsButton
                                .transition(.opacity.combined(with: .scale(scale: 0.86)))
                        }
                        Spacer(minLength: 0)
                            .allowsHitTesting(false)
                    }
                    .animation(.spring(response: 0.38, dampingFraction: 0.86), value: chat.composerOpen)
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
                .safeAreaPadding(.top)
                .safeAreaPadding(.horizontal)
                .padding(.bottom, chat.keyboardScrubLift)
                .safeAreaPadding(chat.keyboardScrubLift > 0 ? Edge.Set() : .bottom)
                .ignoresSafeArea(chat.keyboardScrubLift > 0 ? .all : [], edges: .bottom)
            }
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
            ZStack {
                Image(systemName: "circle.fill")
                    .foregroundStyle(Color(red: 242 / 255, green: 242 / 255, blue: 247 / 255))
                Image(systemName: "circle.lefthalf.filled")
                    .foregroundStyle(Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255))
            }
            .font(.system(size: orbSide * 0.38, weight: .semibold))
            .frame(width: orbSide, height: orbSide)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .epsSizedGlassCircle(side: orbSide)
        .accessibilityLabel("Cycle theme")
    }
}
