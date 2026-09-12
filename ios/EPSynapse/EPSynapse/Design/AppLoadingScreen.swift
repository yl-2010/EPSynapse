import SwiftUI

struct AppLoadingScreen: View {
    var body: some View {
        ZStack {
            EPSTheme.bg0.ignoresSafeArea()
            Image("LogoMark")
                .resizable()
                .scaledToFit()
                .frame(width: 96, height: 96)
        }
        .allowsHitTesting(true)
    }
}
