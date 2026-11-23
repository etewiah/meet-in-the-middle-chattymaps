// Apple Maps lookups for `middle` on macOS: no API keys, no accounts.
// Same idea as George Mandis's `whereami` and `nearme` (MapKit + CoreLocation),
// written fresh in Swift. Compiled once by src/apple.js and cached.
//
//   mapkit-helper geocode <text> [countryCode] [nearLat nearLng]
//   mapkit-helper search <query> <lat> <lng> <radiusM>
//   mapkit-helper reverse <lat> <lng>
//   mapkit-helper locate
//
// Prints one JSON value on stdout. On failure prints {"error": "..."} and exits 1.
import CoreLocation
import Foundation
import MapKit

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

/// Runs the main run loop until `done` or the timeout, so completion handlers fire.
func runUntil(seconds: Double = 20, _ done: () -> Bool) -> Bool {
  let until = Date().addingTimeInterval(seconds)
  while !done() && Date() < until {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  return done()
}

func wait(seconds: Double = 20, timeoutMessage: String = "Apple Maps did not answer in time", _ done: () -> Bool) {
  if !runUntil(seconds: seconds, done) { fail(timeoutMessage) }
}

final class CompleterDelegate: NSObject, MKLocalSearchCompleterDelegate {
  var results: [MKLocalSearchCompletion] = []
  var finished = false

  func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
    results = completer.results
    finished = true
  }

  func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
    finished = true
  }
}

func clGeocode(_ query: String, country: String?) -> (CLPlacemark?, String?) {
  var match: CLPlacemark? = nil
  var problem: String? = nil
  var done = false
  CLGeocoder().geocodeAddressString(query) { marks, error in
    match = (marks ?? []).first { country == nil || $0.isoCountryCode == country }
    if match == nil, let error = error as? CLError, error.code != .geocodeFoundNoResult {
      problem = "Apple Maps geocoding failed (\(error.code.rawValue))"
    }
    done = true
  }
  wait { done }
  return (match, problem)
}

/// Fallback when CLGeocoder's single global hit is in the wrong country (e.g. "Kingston" → Jamaica
/// when --country=gb wants Kingston upon Thames). Completer returns ranked local candidates.
func completerGeocode(_ query: String, country: String, near: CLLocationCoordinate2D?) -> CLPlacemark? {
  let completer = MKLocalSearchCompleter()
  let delegate = CompleterDelegate()
  completer.delegate = delegate
  completer.resultTypes = [.address]
  if let near {
    completer.region = MKCoordinateRegion(center: near, latitudinalMeters: 100_000, longitudinalMeters: 100_000)
  }
  completer.queryFragment = query
  guard runUntil(seconds: 10, { delegate.finished }) else { return nil }

  let countryName = Locale(identifier: "en_US").localizedString(forRegionCode: country)?.lowercased()
  let ordered = delegate.results.sorted { a, b in
    guard let cn = countryName else { return false }
    let aHas = a.subtitle.lowercased().contains(cn)
    let bHas = b.subtitle.lowercased().contains(cn)
    return aHas && !bHas
  }
  for completion in ordered.prefix(5) {
    var placemark: CLPlacemark? = nil
    var done = false
    MKLocalSearch(request: MKLocalSearch.Request(completion: completion)).start { response, _ in
      placemark = response?.mapItems.first?.placemark
      done = true
    }
    if runUntil(seconds: 10, { done }), let pm = placemark, pm.isoCountryCode == country, pm.location != nil {
      return pm
    }
  }
  return nil
}

final class LocationDelegate: NSObject, CLLocationManagerDelegate {
  var coordinate: CLLocationCoordinate2D?
  var accuracy: CLLocationAccuracy?
  var errorMessage: String?
  var finished = false
  private let manager: CLLocationManager

  init(_ manager: CLLocationManager) {
    self.manager = manager
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
  }

  func start() {
    if !CLLocationManager.locationServicesEnabled() {
      errorMessage = "Location Services is turned off. Turn it on in System Settings → Privacy & Security → Location Services."
      finished = true
      return
    }
    let status = manager.authorizationStatus
    if status == .denied || status == .restricted {
      errorMessage = "Location Services access is denied. Enable it for your terminal in System Settings → Privacy & Security → Location Services."
      finished = true
      return
    }
    if status == .notDetermined {
      manager.requestWhenInUseAuthorization()
    }
    manager.startUpdatingLocation()
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    if status == .denied || status == .restricted {
      errorMessage = "Location Services access was denied. Enable it for your terminal in System Settings → Privacy & Security → Location Services."
      finished = true
    } else if status == .authorizedAlways {
      manager.startUpdatingLocation()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let latest = locations.last else { return }
    coordinate = latest.coordinate
    accuracy = latest.horizontalAccuracy
    manager.stopUpdatingLocation()
    finished = true
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    if let clError = error as? CLError {
      switch clError.code {
      case .denied:
        errorMessage = "Location Services access was denied. Enable it for your terminal in System Settings → Privacy & Security → Location Services."
        finished = true
      case .locationUnknown:
        return
      default:
        errorMessage = "Couldn't get your current location (CoreLocation error \(clError.code.rawValue)). Make sure Wi-Fi and Location Services are on."
        finished = true
      }
    } else {
      errorMessage = "Couldn't get your current location: \(error.localizedDescription)"
      finished = true
    }
  }
}

func number(_ text: String, _ name: String) -> Double {
  guard let value = Double(text), value.isFinite else { fail("\(name) must be a number") }
  return value
}

func addressLine(_ p: CLPlacemark) -> String? {
  let street = [p.subThoroughfare, p.thoroughfare].compactMap { $0 }.joined(separator: " ")
  let parts = [street.isEmpty ? nil : street, p.locality, p.postalCode].compactMap { $0 }
  return parts.isEmpty ? nil : parts.joined(separator: ", ")
}

func categoryName(_ category: MKPointOfInterestCategory?) -> String? {
  guard let raw = category?.rawValue, raw.hasPrefix("MKPOICategory") else { return nil }
  let name = String(raw.dropFirst("MKPOICategory".count))
  // "FitnessCenter" -> "fitness center"
  var words = ""
  for ch in name {
    if ch.isUppercase && !words.isEmpty { words.append(" ") }
    words.append(ch)
  }
  return words.lowercased()
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: mapkit-helper geocode|search|reverse|locate …") }
let geocoder = CLGeocoder()
var finished = false

switch command {
case "geocode":
  guard args.count >= 2 else { fail("usage: mapkit-helper geocode <text> [countryCode] [nearLat nearLng]") }
  let country = args.count >= 3 && !args[2].isEmpty ? args[2].uppercased() : nil
  let near: CLLocationCoordinate2D? = args.count >= 5
    ? CLLocationCoordinate2D(latitude: number(args[3], "nearLat"), longitude: number(args[4], "nearLng"))
    : nil
  var (match, problem) = clGeocode(args[1], country: country)
  if match == nil, problem == nil, let country {
    match = completerGeocode(args[1], country: country, near: near)
    if match == nil, let countryName = Locale(identifier: "en_US").localizedString(forRegionCode: country) {
      (match, problem) = clGeocode("\(args[1]), \(countryName)", country: country)
    }
  }
  if let problem { fail(problem) }
  if let m = match, let c = m.location?.coordinate {
    var name = [m.name, m.locality].compactMap { $0 }
    if name.count == 2 && name[0].lowercased() == name[1].lowercased() { name.removeLast() }
    let payload: [String: Any] = [
      "name": name.isEmpty ? args[1] : name.joined(separator: ", "),
      "lat": c.latitude, "lng": c.longitude,
      "countryCode": m.isoCountryCode?.lowercased() ?? NSNull(),
    ]
    emit(payload)
  } else {
    emit(NSNull())
  }

case "search":
  guard args.count >= 5 else { fail("usage: mapkit-helper search <query> <lat> <lng> <radiusM>") }
  let center = CLLocationCoordinate2D(latitude: number(args[2], "lat"), longitude: number(args[3], "lng"))
  let radius = number(args[4], "radiusM")
  let request = MKLocalSearch.Request()
  request.naturalLanguageQuery = args[1]
  request.region = MKCoordinateRegion(center: center, latitudinalMeters: radius * 2, longitudinalMeters: radius * 2)
  request.resultTypes = .pointOfInterest
  // Without this, MapKit treats the region as a hint and can return places
  // several kilometres away. The CLI still filters by distance afterwards.
  if #available(macOS 15.0, *) { request.regionPriority = .required }
  var places: [[String: Any]] = []
  var problem: String? = nil
  MKLocalSearch(request: request).start { response, error in
    for item in response?.mapItems ?? [] {
      let c = item.placemark.coordinate
      places.append([
        "name": item.name ?? "Unnamed place",
        "lat": c.latitude, "lng": c.longitude,
        "address": addressLine(item.placemark) ?? NSNull(),
        "kind": categoryName(item.pointOfInterestCategory) ?? NSNull(),
        "phone": item.phoneNumber ?? NSNull(),
        "url": item.url?.absoluteString ?? NSNull(),
      ])
    }
    // "No results" is an empty list, not a failure.
    if let error = error as? MKError, error.code != .placemarkNotFound {
      problem = "Apple Maps search failed (\(error.code.rawValue))"
    }
    finished = true
  }
  wait { finished }
  if let problem { fail(problem) }
  emit(places)

case "reverse":
  guard args.count >= 3 else { fail("usage: mapkit-helper reverse <lat> <lng>") }
  let location = CLLocation(latitude: number(args[1], "lat"), longitude: number(args[2], "lng"))
  var result: [String: Any]? = nil
  geocoder.reverseGeocodeLocation(location) { marks, _ in
    if let m = marks?.first, let label = m.subLocality ?? m.locality ?? m.name {
      result = [
        "label": label,
        "regionLabel": (m.locality != nil && m.locality != label) ? m.locality! : NSNull(),
        "countryCode": m.isoCountryCode?.lowercased() ?? NSNull(),
      ]
    }
    finished = true
  }
  wait { finished }
  emit(result ?? NSNull())

case "locate":
  let manager = CLLocationManager()
  let delegate = LocationDelegate(manager)
  delegate.start()
  wait(
    seconds: 30,
    timeoutMessage: "Timed out waiting for your current location. Make sure Wi-Fi is on and allow Location Services for your terminal in System Settings → Privacy & Security → Location Services."
  ) { delegate.finished }
  if let message = delegate.errorMessage { fail(message) }
  guard let c = delegate.coordinate else { fail("Couldn't get your current location.") }
  var payload: [String: Any] = ["lat": c.latitude, "lng": c.longitude]
  if let accuracy = delegate.accuracy { payload["accuracyM"] = accuracy }
  emit(payload)

default:
  fail("unknown command \(command)")
}
