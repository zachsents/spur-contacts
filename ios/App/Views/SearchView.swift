import SwiftUI

/// The root: a search over everyone (`search`), and, before anything's typed, the people the spur
/// recently identified from unsaved numbers (`identified`).
struct SearchView: View {
  let model: Model
  @State private var query = ""
  @State private var hits: [Hit] = []
  @State private var identified: [Hit] = []
  @State private var problem: String?
  @FocusState private var typing: Bool

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      SearchField(text: $query, focus: $typing)
      if let problem { Problem(text: problem) }
      ScrollView {
        LazyVStack(spacing: 0) {
          if query.trimmingCharacters(in: .whitespaces).isEmpty {
            if !identified.isEmpty {
              BoardSection(label: "Identified", count: identified.count, first: true) {
                Rule()
                ForEach(identified) { HitRow(hit: $0, model: model) }
              }
            }
          } else if hits.isEmpty {
            Empty("No one")
          } else {
            ForEach(hits) { HitRow(hit: $0, model: model) }
          }
        }
      }
      .scrollDismissesKeyboard(.immediately)
    }
    .background(SIS.paper)
    .band("Contacts")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          model.path.append(.history)
        } label: {
          Image(systemName: "clock.arrow.circlepath")
        }
        .accessibilityLabel("History")
      }
    }
    .task(id: "\(query)|\(model.changes)") { await search() }
    .task(id: model.changes) { await loadIdentified() }
    .seen(model.core, "search")
  }

  private func search() async {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else {
      hits = []
      return
    }
    try? await Task.sleep(for: .milliseconds(120))
    guard !Task.isCancelled else { return }
    do {
      let r = try await model.core.call("search", ["query": .string(q), "limit": 40])
      guard !Task.isCancelled else { return }
      hits = r["people"].array.map(Hit.init)
      problem = nil
    } catch {
      if !Task.isCancelled { problem = error.localizedDescription }
    }
  }

  private func loadIdentified() async {
    do {
      identified = try await model.core.call("identified")["people"].array.map(Hit.init)
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// The box a person types in: inset, its shade inside its top edge.
struct SearchField: View {
  @Binding var text: String
  var focus: FocusState<Bool>.Binding
  var placeholder = "Search"

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .medium)).foregroundStyle(SIS.ink3)
      TextField(placeholder, text: $text)
        .font(SIS.text(16))
        .foregroundStyle(SIS.ink)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
        .focused(focus)
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill").foregroundStyle(SIS.ink3)
        }
        .accessibilityLabel("Clear")
      }
    }
    .padding(.horizontal, 12)
    .frame(height: SIS.fieldHeight)
    .background(RoundedRectangle(cornerRadius: SIS.fieldRadius).fill(SIS.Field.fill))
    .overlay(RoundedRectangle(cornerRadius: SIS.fieldRadius).stroke(SIS.Field.border, lineWidth: 1))
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Rule() }
  }
}

/// A person in a list: their name, and their phone, email or company at the end.
struct HitRow: View {
  let hit: Hit
  let model: Model
  var action: (() -> Void)?

  var body: some View {
    RowButton(action: { if let action { action() } else { model.path.append(.person(hit.id)) } }) {
      Text(hit.name.isEmpty ? hit.detail : hit.name).lineLimit(1)
      Spacer(minLength: 8)
      if !hit.name.isEmpty { Figure(hit.detail) }
    }
  }
}
