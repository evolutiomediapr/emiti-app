import Foundation
import Capacitor
import ContactsUI

@objc(EmitContactsPlugin)
public class EmitContactsPlugin: CAPPlugin, CAPBridgedPlugin, CNContactPickerDelegate {
    public let identifier = "EmitContactsPlugin"
    public let jsName = "EmitContacts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickContact", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    // Usa CNContactPickerViewController (picker OUT-OF-PROCESS): la app NUNCA
    // accede a la agenda completa ni a CNContactStore. iOS devuelve SOLO el
    // contacto que el usuario elige, por eso NO requiere NSContactsUsageDescription
    // ni prompt de permiso. Frameworks Contacts/ContactsUI se auto-linkean al
    // import (igual que StoreKit en EmitIAPPlugin, sin entrada de linking en pbxproj).
    @objc func pickContact(_ call: CAPPluginCall) {
        pendingCall = call
        DispatchQueue.main.async {
            let picker = CNContactPickerViewController()
            picker.delegate = self
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
        let name = [contact.givenName, contact.familyName]
            .filter { !$0.isEmpty }.joined(separator: " ")
        var result: [String: Any] = ["name": name]
        if let phone = contact.phoneNumbers.first?.value.stringValue { result["phone"] = phone }
        if let email = contact.emailAddresses.first?.value as String? { result["email"] = email }
        if let postal = contact.postalAddresses.first?.value {
            result["address"] = CNPostalAddressFormatter
                .string(from: postal, style: .mailingAddress)
                .replacingOccurrences(of: "\n", with: ", ")
        }
        pendingCall?.resolve(result)
        pendingCall = nil
    }

    public func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        pendingCall?.resolve(["cancelled": true])
        pendingCall = nil
    }
}
