import SwiftUI
import UIKit

enum EPSHaptics {
    static func tap() {
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    }

    static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    static func swipeBegin() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
}

extension View {
    func epsHapticOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { EPSHaptics.tap() })
    }

    func epsHapticNavigation() -> some View {
        simultaneousGesture(TapGesture().onEnded { EPSHaptics.medium() })
    }

    /// Swipe-back haptics on pushed pages (class, note, todo). The hosting
    /// controller sits under UINavigationController so we can watch the pop
    /// gesture. On iOS 26+ we also attach to the full-content pop recognizer.
    func epsSwipeBackHaptics() -> some View {
        background(EPSSwipeBackHapticsObserver())
    }
}

/// Fires a medium haptic when progress crosses the threshold either way,
/// including while a spring is still moving.
final class EPSHalfwayHapticGate {
    private var lastProgress: CGFloat?
    private let threshold: CGFloat

    init(threshold: CGFloat = 0.5) {
        self.threshold = threshold
    }

    func handle(_ progress: CGFloat) {
        defer { lastProgress = progress }
        guard let last = lastProgress else { return }
        let crossedUp = last < threshold && progress >= threshold
        let crossedDown = last >= threshold && progress < threshold
        guard crossedUp || crossedDown else { return }
        EPSHaptics.medium()
    }

    func reset() {
        lastProgress = nil
    }
}

/// Reports an animated 0…1 progress every frame so halfway haptics can fire mid-spring.
struct EPSProgressMonitor: AnimatableModifier {
    var progress: CGFloat
    var onProgress: (CGFloat) -> Void

    var animatableData: CGFloat {
        get { progress }
        set {
            progress = newValue
            onProgress(newValue)
        }
    }

    func body(content: Content) -> some View {
        content
    }
}

/// Watches the system interactive pop. iOS 26 uses full-content swipe via
/// `interactiveContentPopGestureRecognizer`; earlier OS uses edge-only
/// `interactivePopGestureRecognizer`. We attach to both when available.
private struct EPSSwipeBackHapticsObserver: UIViewControllerRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        controller.view.isUserInteractionEnabled = false
        controller.view.backgroundColor = .clear
        DispatchQueue.main.async {
            context.coordinator.attach(from: controller)
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        context.coordinator.attach(from: uiViewController)
    }

    final class Coordinator: NSObject {
        private weak var edgeGesture: UIGestureRecognizer?
        private weak var contentGesture: UIGestureRecognizer?
        private var lastProgress: CGFloat?
        private let commitThreshold: CGFloat = 0.35

        func attach(from controller: UIViewController) {
            guard let nav = Self.findNavigationController(from: controller) else { return }

            let edge = nav.interactivePopGestureRecognizer
            if edge !== edgeGesture {
                edgeGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
                edge?.addTarget(self, action: #selector(handlePopGesture(_:)))
                edgeGesture = edge
            }

            if #available(iOS 26, *) {
                let content = nav.interactiveContentPopGestureRecognizer
                if content !== contentGesture {
                    contentGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
                    content?.addTarget(self, action: #selector(handlePopGesture(_:)))
                    contentGesture = content
                }
            }
        }

        private static func findNavigationController(from controller: UIViewController) -> UINavigationController? {
            if let nav = controller.navigationController { return nav }
            var parent = controller.parent
            while let current = parent {
                if let nav = current as? UINavigationController { return nav }
                if let nav = current.navigationController { return nav }
                parent = current.parent
            }
            guard let root = controller.view.window?.rootViewController
                    ?? controller.viewIfLoaded?.window?.rootViewController
            else { return nil }
            return deepestNavigation(from: root)
        }

        private static func deepestNavigation(from root: UIViewController) -> UINavigationController? {
            if let nav = root as? UINavigationController { return nav }
            for child in root.children.reversed() {
                if let found = deepestNavigation(from: child) { return found }
            }
            if let presented = root.presentedViewController {
                return deepestNavigation(from: presented)
            }
            return root.navigationController
        }

        private func gestureProgress(_ gesture: UIGestureRecognizer) -> CGFloat {
            if let pan = gesture as? UIPanGestureRecognizer {
                let view = pan.view
                let width = max(view?.bounds.width ?? UIScreen.main.bounds.width, 1)
                return min(max(pan.translation(in: view).x / width, 0), 1)
            }
            return 0
        }

        @objc func handlePopGesture(_ gesture: UIGestureRecognizer) {
            switch gesture.state {
            case .began:
                lastProgress = nil
                EPSHaptics.swipeBegin()

            case .changed:
                let progress = gestureProgress(gesture)
                defer { lastProgress = progress }
                guard let last = lastProgress else { return }
                let crossedForward = last < commitThreshold && progress >= commitThreshold
                let crossedBack = last >= commitThreshold && progress < commitThreshold
                guard crossedForward || crossedBack else { return }
                EPSHaptics.medium()

            case .ended, .cancelled, .failed:
                lastProgress = nil

            default:
                break
            }
        }

        deinit {
            edgeGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
            contentGesture?.removeTarget(self, action: #selector(handlePopGesture(_:)))
        }
    }
}
