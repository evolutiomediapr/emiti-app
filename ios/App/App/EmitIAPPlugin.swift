import Foundation
import Capacitor
import StoreKit

@objc(EmitIAPPlugin)
public class EmitIAPPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EmitIAPPlugin"
    public let jsName = "EmitIAP"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "purchasePro", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise)
    ]

    private let productID = "app.emiti.app.pro.monthly"

    @objc func purchasePro(_ call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: [productID])
                guard let product = products.first else {
                    call.reject("Product not found: \(productID)")
                    return
                }

                let result = try await product.purchase()

                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        await transaction.finish()
                        call.resolve([
                            "success": true,
                            "transactionId": String(transaction.id),
                            "originalTransactionId": String(transaction.originalID),
                            "productId": transaction.productID,
                            "jws": verification.jwsRepresentation
                        ])
                    case .unverified(_, let error):
                        call.reject("Unverified transaction: \(error.localizedDescription)")
                    }
                case .userCancelled:
                    call.reject("User cancelled")
                case .pending:
                    call.reject("Purchase pending parental approval")
                @unknown default:
                    call.reject("Unknown purchase result")
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            for await result in Transaction.currentEntitlements {
                if case .verified(let transaction) = result,
                   transaction.productID == productID,
                   transaction.revocationDate == nil {
                    await transaction.finish()
                    call.resolve([
                        "restored": true,
                        "transactionId": String(transaction.id),
                        "originalTransactionId": String(transaction.originalID),
                        "productId": transaction.productID,
                        "jws": result.jwsRepresentation
                    ])
                    return
                }
            }
            call.resolve(["restored": false])
        }
    }
}
