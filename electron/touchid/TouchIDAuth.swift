// Native Touch ID / biometric gate for macOS.
// Called as a short-lived CLI process from Electron's main process.
// Prints TOUCHID_OK or TOUCHID_FAIL to stdout and exits 0 / 1 accordingly.
// This process does not touch any SSH key, passphrase, or server
// credential — it only asks the OS "did this human pass biometric check?"

import LocalAuthentication
import Foundation

let context = LAContext()
var error: NSError?

let reason = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Confirm to access server"

guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
    // No biometric hardware/enrollment available — caller must fall back
    // to a manual unlock path (e.g. typed passphrase), never auto-allow.
    print("TOUCHID_UNAVAILABLE")
    exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var authSucceeded = false

context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, evalError in
    authSucceeded = success
    semaphore.signal()
}

semaphore.wait()

if authSucceeded {
    print("TOUCHID_OK")
    exit(0)
} else {
    print("TOUCHID_FAIL")
    exit(1)
}
