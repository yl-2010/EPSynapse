import SwiftUI
import UIKit

extension Notification.Name {
    static let epsDismissKeyboard = Notification.Name("eps.dismissKeyboard")
}

extension View {
    /// Tap anything that is not a text field and the keyboard plus caret go away.
    func dismissKeyboardOnOutsideTap() -> some View {
        background {
            OutsideTapKeyboardDismiss()
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

enum KeyboardDismiss {
    static func resign() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
        NotificationCenter.default.post(name: .epsDismissKeyboard, object: nil)
    }
}

private struct OutsideTapKeyboardDismiss: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.attach(from: uiView)
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var host: UIView?
        var recognizer: UITapGestureRecognizer?

        func attach(from view: UIView) {
            guard let window = view.window else { return }
            if recognizer != nil, host === window { return }
            detach()
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            window.addGestureRecognizer(tap)
            recognizer = tap
            host = window
        }

        func detach() {
            if let tap = recognizer, let host {
                host.removeGestureRecognizer(tap)
            }
            recognizer = nil
            host = nil
        }

        @objc func handleTap() {
            KeyboardDismiss.resign()
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldReceive touch: UITouch
        ) -> Bool {
            if isInsideTextInput(touch.view) { return false }
            if let window = touch.view?.window,
               let field = firstResponderInput(in: window) {
                let point = touch.location(in: window)
                let pad = field.convert(field.bounds, to: window).insetBy(dx: -20, dy: -20)
                if pad.contains(point) { return false }
            }
            return true
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }

        private func isInsideTextInput(_ view: UIView?) -> Bool {
            var node = view
            while let current = node {
                if isTextInput(current) { return true }
                node = current.superview
            }
            return false
        }

        private func isTextInput(_ view: UIView) -> Bool {
            if view is UITextField || view is UITextView || view is UISearchBar {
                return true
            }
            let name = String(describing: type(of: view))
            return name.contains("TextField")
                || name.contains("TextView")
                || name.contains("TextEditor")
        }

        private func firstResponderInput(in root: UIView) -> UIView? {
            if root.isFirstResponder, isTextInput(root) { return root }
            for child in root.subviews {
                if let found = firstResponderInput(in: child) { return found }
            }
            return nil
        }
    }
}
