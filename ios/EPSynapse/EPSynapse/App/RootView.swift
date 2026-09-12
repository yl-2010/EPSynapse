import SwiftUI

struct RootView: View {
    var body: some View {
        ZStack {
            HomeView()
            CornerChrome()
        }
        .epsPageBackground()
        .toolbar(.hidden, for: .navigationBar)
    }
}
