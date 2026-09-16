import SwiftUI

/// Matches LaunchScreen: themed page color + flat mark.
struct AppLoadingScreen: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width * 0.28, 150)
            ZStack {
                EPSTheme.bg0(colorScheme)
                    .ignoresSafeArea()
                Image("LogoMark")
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: side, height: side)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("EPSynapse")
    }
}
