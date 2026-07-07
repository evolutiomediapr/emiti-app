import Capacitor

class ViewController: CAPBridgeViewController {
    // EmitIAPPlugin es un plugin LOCAL (embebido en el target App, no un paquete
    // npm). En el esquema SPM de Capacitor 6 el bridge NO auto-descubre plugins
    // por el runtime ObjC: solo registra los integrados + los de packageClassList,
    // y la CLI regenera packageClassList en cada `cap sync` dejando solo plugins npm.
    // Por eso lo registramos explícitamente aquí (código fuente, que cap sync no
    // sobrescribe). Corre después de registerPlugins() del init del bridge, así
    // que se suma al auto-registro de FilePicker y los plugins integrados.
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(EmitIAPPlugin())
        bridge?.registerPluginInstance(EmitContactsPlugin())
    }
}
