// Apple Maps lookups for `middle` on macOS: no API keys, no accounts.
// Same idea as George Mandis's `whereami` and `nearme` (MapKit + CoreLocation),
// written fresh in Swift. Compiled once by src/apple.js and cached.
//
//   mapkit-helper geocode <text> [countryCode]
//   mapkit-helper search <query> <lat> <lng> <radiusM>
//   mapkit-helper reverse <lat> <lng>
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
func wait(seconds: Double = 20, _ done: () -> Bool) {
  let until = Date().addingTimeInterval(seconds)
  while !done() && Date() < until {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  if !done() { fail("Apple Maps did not answer in time") }
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
guard let command = args.first else { fail("usage: mapkit-helper geocode|search|reverse …") }
let geocoder = CLGeocoder()
var finished = false

switch command {
case "geocode":
  guard args.count >= 2 else { fail("usage: mapkit-helper geocode <text> [countryCode]") }
  let country = args.count >= 3 ? args[2].uppercased() : nil
  var result: [String: Any]? = nil
  var problem: String? = nil
  geocoder.geocodeAddressString(args[1]) { marks, error in
    let match = (marks ?? []).first { country == nil || $0.isoCountryCode == country }
    if let m = match, let c = m.location?.coordinate {
      var name = [m.name, m.locality].compactMap { $0 }
      if name.count == 2 && name[0] == name[1] { name.removeLast() }
      result = [
        "name": name.isEmpty ? args[1] : name.joined(separator: ", "),
        "lat": c.latitude, "lng": c.longitude,
        "countryCode": m.isoCountryCode?.lowercased() ?? NSNull(),
      ]
    } else if let error = error as? CLError, error.code != .geocodeFoundNoResult {
      problem = "Apple Maps geocoding failed (\(error.code.rawValue))"
    }
    finished = true
  }
  wait { finished }
  if let problem { fail(problem) }
  emit(result ?? NSNull())

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

default:
  fail("unknown command \(command)")
}
