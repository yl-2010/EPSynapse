import Foundation

enum CourseTitle {
  static func pretty(_ raw: String) -> String {
    let src = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !src.isEmpty else { return src }
    var s = src
    s = replace(#"\s*\([^)]*\)"#, in: s, with: " ")
    s = replace(#"\btri(?:mester)?\s*[1-3]\b"#, in: s, with: " ")
    s = replace(#"\b(fall|winter|spring|year|trimester)\b"#, in: s, with: " ")
    s = replace(#"\s*\d{4}(?:\s*[-/]\s*\d{2,4})?\S*"#, in: s, with: " ")
    s = replace(#"\s*:[A-Za-z][A-Za-z0-9_-]*$"#, in: s, with: " ")
    s = replace(#"\s+"#, in: s, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    return s.isEmpty ? src : s
  }

  private static func replace(_ pattern: String, in text: String, with replacement: String) -> String {
    text.replacingOccurrences(
      of: pattern,
      with: replacement,
      options: [.regularExpression, .caseInsensitive]
    )
  }
}
