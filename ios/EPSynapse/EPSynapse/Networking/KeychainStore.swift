import Foundation
import Security

/// Generic-password items for this app. Device-only, unlocked-only, no iCloud sync.
enum KeychainStore {
  static let service = "com.jype.epsynapse"
  static let sessionAccount = "session"

  static func read(account: String) -> String? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// Adds the item, or updates it in place if one already exists.
  @discardableResult
  static func write(_ value: String, account: String) -> Bool {
    let data = Data(value.utf8)
    let query = baseQuery(account: account)
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let updated = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updated == errSecSuccess { return true }
    guard updated == errSecItemNotFound else { return false }
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  static func delete(account: String) {
    SecItemDelete(baseQuery(account: account) as CFDictionary)
  }

  private static func baseQuery(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
  }
}
