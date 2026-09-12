import SwiftUI

struct AppLoadingScreen: View {
    var body: some View {
        ZStack {
            EPSTheme.bg0.ignoresSafeArea()
            EPSMark()
                .fill(EPSTheme.accent)
                .frame(width: 72, height: 72)
        }
        .allowsHitTesting(true)
    }
}
