import SwiftUI

@main
struct ContactsApp: App {
  @Environment(\.scenePhase) private var phase
  @State private var model = Model()

  var body: some Scene {
    WindowGroup {
      NavigationStack(path: $model.path) {
        SearchView(model: model)
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .person(let id): PersonView(model: model, id: id)
            case .history: HistoryView(model: model)
            }
          }
      }
      .tint(SIS.ink)
      .preferredColorScheme(.dark)
      .onOpenURL { model.open(url: $0) }
    }
    .onChange(of: phase) { _, now in
      if now == .active { model.core.wake() }
    }
  }
}

enum Route: Hashable {
  case person(String)
  case history
}

/// One person as `search` and `identified` list them.
struct Hit: Identifiable, Hashable {
  let id: String
  let name: String
  /// What's under the name: their phone, else email, else company.
  let detail: String

  init(_ j: JSON) {
    id = j["id"].str
    name = j["name"].str
    detail = [j["phone"].str, j["email"].str, j["company"].str].first { !$0.isEmpty } ?? ""
  }
}

/// The app: the core, where the user is, and what changed (moved on each of Contacts' events, so
/// what's on screen reads again).
@MainActor @Observable
final class Model {
  let core = Core(app: "contacts")
  var path: [Route] = []
  /// Moves on every change the spur logs.
  private(set) var changes = 0
  /// The last change made here, for its Undo.
  var done: Done?

  struct Done: Equatable {
    let text: String
    let batch: String
  }

  init() {
    core.on(
      [
        "contacts.person_created", "contacts.person_updated", "contacts.person_merged", "contacts.person_split",
        "contacts.person_retired", "contacts.enriched", "contacts.sender_identified", "contacts.undone",
      ]
    ) { [weak self] _, _ in self?.changes += 1 }
    core.start()
    // A page to open at launch (`-open switch-contacts://person/<id>`), as a link would.
    if let link = UserDefaults.standard.string(forKey: "open"), let url = URL(string: link) { open(url: url) }
  }

  /// `switch-contacts://person/<id>`.
  func open(url: URL) {
    let id = url.pathComponents.dropFirst().first ?? ""
    if url.host() == "person", !id.isEmpty { path = [.person(id)] }
    if url.host() == "history" { path = [.history] }
  }

  func undo(_ batch: String) async throws {
    _ = try await core.call("undo", ["batch": .string(batch)])
    if done?.batch == batch { done = nil }
    changes += 1
  }
}
