import SwiftUI
import UIKit

/// Canvas LMS web URLs and the Student app's `canvas-courses://` scheme.
enum CanvasLMS {
    static let studentAppScheme = "canvas-courses"

    static func webURL(from raw: String?) -> URL? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    static func studentAppURL(from webURL: URL) -> URL? {
        guard let host = webURL.host, !host.isEmpty else { return nil }
        var comps = URLComponents(url: webURL, resolvingAgainstBaseURL: false)
        comps?.scheme = studentAppScheme
        return comps?.url
    }

    /// Canvas Student when installed, otherwise Safari.
    static func open(_ webURL: URL) {
        if let appURL = studentAppURL(from: webURL),
           UIApplication.shared.canOpenURL(appURL)
        {
            UIApplication.shared.open(appURL, options: [:]) { ok in
                if !ok { UIApplication.shared.open(webURL) }
            }
            return
        }
        UIApplication.shared.open(webURL)
    }
}

/// Opens Canvas Student (`canvas-courses://`) when installed, otherwise Safari.
struct CanvasToolbarButton: View {
    let webURL: URL
    var scoreLabel: String = ""
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button {
            CanvasLMS.open(webURL)
        } label: {
            Group {
                if scoreLabel.isEmpty {
                    Image("CanvasMark")
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 18, height: 18)
                        .foregroundStyle(EPSTheme.fg(colorScheme))
                } else {
                    Text(scoreLabel)
                        .font(.system(size: scoreLabel.count > 6 ? 9 : 11, weight: .bold))
                        .foregroundStyle(EPSTheme.accent(colorScheme))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, 2)
                }
            }
            .frame(width: 36, height: 36)
            .contentShape(Circle())
            .modifier(CanvasToolbarChrome())
        }
        .buttonStyle(.plain)
        .epsHapticOnTap()
        .accessibilityLabel(scoreLabel.isEmpty ? "Open in Canvas" : "Open in Canvas, \(scoreLabel)")
    }
}

/// Row-view grade. Same destination as the Canvas circle on the object page.
struct EducationCanvasScoreButton: View {
    let label: String
    let url: URL?
    var topPadding: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if label.isEmpty {
            EmptyView()
        } else if let url {
            Button {
                CanvasLMS.open(url)
            } label: {
                scoreText
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .epsHapticOnTap()
            .accessibilityLabel("Open in Canvas, \(label)")
        } else {
            scoreText
        }
    }

    private var scoreText: some View {
        Text(label)
            .font(.caption.weight(.bold))
            .foregroundStyle(EPSTheme.accent(colorScheme))
            .monospacedDigit()
            .strikethrough(false)
            .padding(.top, topPadding)
    }
}

/// iOS 26 toolbar already draws one glass circle — don't nest another.
private struct CanvasToolbarChrome: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.glassCircle(interactive: true)
        }
    }
}
