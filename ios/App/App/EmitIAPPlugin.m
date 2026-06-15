#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(EmitIAPPlugin, "EmitIAP",
  CAP_PLUGIN_METHOD(purchasePro, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(restorePurchases, CAPPluginReturnPromise);
)
