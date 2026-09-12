import SwiftUI

/// Website E mark, 24×24 path `M6.2 4h12.1v2.55H9.05v3.7h8.4v2.45h-8.4v4.2H18.6V20H6.2z`.
struct EPSMark: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 24
        let sy = rect.height / 24
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }

        var path = Path()
        path.move(to: pt(6.2, 4))
        path.addLine(to: pt(18.3, 4))
        path.addLine(to: pt(18.3, 6.55))
        path.addLine(to: pt(9.05, 6.55))
        path.addLine(to: pt(9.05, 10.25))
        path.addLine(to: pt(17.45, 10.25))
        path.addLine(to: pt(17.45, 12.7))
        path.addLine(to: pt(9.05, 12.7))
        path.addLine(to: pt(9.05, 16.9))
        path.addLine(to: pt(18.6, 16.9))
        path.addLine(to: pt(18.6, 20))
        path.addLine(to: pt(6.2, 20))
        path.closeSubpath()
        return path
    }
}
