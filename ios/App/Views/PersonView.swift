import SwiftUI

/// One person (`get`): their facts, then every field with where it came from and how sure that is.
/// Its menu looks them up (`enrich`) and merges someone else into them (`merge`); either one's
/// Undo stays at the bottom until the next change.
struct PersonView: View {
  let model: Model
  let id: String
  @State private var person: JSON = .null
  @State private var problem: String?
  @State private var lookingUp = false
  @State private var merging = false

  private var name: String { person["name"].str }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        VStack(spacing: 0) {
          if !person.isNull { content }
        }
      }
      if let done = model.done { DoneBar(model: model, done: done) }
    }
    .background(SIS.paper)
    .band(name)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Look up", systemImage: "magnifyingglass") { Task { await lookUp() } }
            .disabled(lookingUp)
          Button("Merge…", systemImage: "arrow.triangle.merge") { merging = true }
        } label: {
          Image(systemName: "ellipsis")
        }
        .accessibilityLabel("Actions")
      }
    }
    .sheet(isPresented: $merging) {
      MergeSheet(model: model, into: id, intoName: name)
        .presentationDetents([.large])
        .presentationCornerRadius(SIS.radius)
    }
    .task(id: model.changes) { await load() }
    .seen(model.core, "person", id)
  }

  @ViewBuilder private var content: some View {
    let fields = person["fields"].array
    let held = fields.filter { $0["suggested"].bool != true && $0["kind"].str != "ref" }
    let suggested = fields.filter { $0["suggested"].bool == true }
    HStack(spacing: 10) {
      Text(name.isEmpty ? "Unnamed" : name).font(SIS.text(SIS.Size.title, weight: .bold)).foregroundStyle(SIS.ink).lineLimit(2)
      Spacer(minLength: 8)
      if lookingUp { Runner(size: SIS.markLarge) }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 14)
    BoardSection(label: "Facts", count: nil) {
      Rule()
      ForEach(Array(person["facts"].array.enumerated()), id: \.offset) { _, f in
        Field(label: f["label"].str, value: f["value"].str)
      }
    }
    BoardSection(label: "Sources", count: held.count) {
      Rule()
      ForEach(held, id: \.self) { SourceRow(field: $0) }
    }
    if !suggested.isEmpty {
      BoardSection(mark: AnyView(Hand(size: 13)), label: "Suggested", count: suggested.count) {
        Rule()
        ForEach(suggested, id: \.self) { SourceRow(field: $0) }
      }
    }
  }

  private func load() async {
    do {
      person = try await model.core.call("get", ["person": .string(id)])
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }

  private func lookUp() async {
    lookingUp = true
    defer { lookingUp = false }
    do {
      let r = try await model.core.call("enrich", ["person": .string(id)])
      let found = r["findings"].array.count
      let batch = try await model.core.call("log", ["limit": 1])["batches"].array.first?["batch"].str ?? ""
      model.done = Model.Done(text: found == 0 ? "Nothing found" : "Found \(found)", batch: batch.hasPrefix("enrich") ? batch : "")
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// A field: its value and kind, and where it came from and how sure, at the end.
private struct SourceRow: View {
  let field: JSON

  var body: some View {
    let kind = field["label"].string ?? field["service"].string ?? field["kind"].str
    let sure = Int(((field["confidence"].number ?? 0) * 100).rounded())
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(field["value"].str).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(2).textSelection(.enabled)
        Text(kind.replacingOccurrences(of: "_", with: " ").capitalized).font(SIS.text(SIS.Size.label, weight: .semibold)).foregroundStyle(SIS.ink3)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 2) {
        Text(field["user"].bool == true ? "You" : field["source"].str.capitalized).font(SIS.data()).foregroundStyle(SIS.ink2)
        Text("\(sure)%").font(SIS.data()).foregroundStyle(SIS.ink3)
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// What was just done, and its Undo.
struct DoneBar: View {
  let model: Model
  let done: Model.Done
  @State private var problem: String?

  var body: some View {
    VStack(spacing: 0) {
      Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth)
      HStack(spacing: 10) {
        Text(problem ?? done.text).font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1)
        Spacer(minLength: 8)
        if !done.batch.isEmpty {
          Button("Undo") {
            Task {
              do { try await model.undo(done.batch) } catch { problem = error.localizedDescription }
            }
          }
          .buttonStyle(KeyStyle())
        }
        Button {
          model.done = nil
        } label: {
          Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
        }
        .buttonStyle(KeyStyle())
        .accessibilityLabel("Close")
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, 10)
    }
    .background(SIS.wash)
  }
}

/// Someone to fold into this person: a search, then a confirmation.
private struct MergeSheet: View {
  let model: Model
  let into: String
  let intoName: String
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var hits: [Hit] = []
  @State private var picked: Hit?
  @State private var problem: String?
  @FocusState private var typing: Bool

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        SearchField(text: $query, focus: $typing, placeholder: "Who")
        if let problem { Problem(text: problem) }
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(hits.filter { $0.id != into }) { hit in
              HitRow(hit: hit, model: model) { picked = hit }
            }
          }
        }
      }
      .background(SIS.paper)
      .band("Merge into \(intoName)")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
      }
    }
    .onAppear { typing = true }
    .task(id: query) {
      let q = query.trimmingCharacters(in: .whitespaces)
      guard !q.isEmpty else { return hits = [] }
      try? await Task.sleep(for: .milliseconds(120))
      guard !Task.isCancelled else { return }
      hits = (try? await model.core.call("search", ["query": .string(q), "limit": 30]))?["people"].array.map(Hit.init) ?? []
    }
    .confirmationDialog(
      "Merge \(picked?.name ?? "") into \(intoName)?", isPresented: Binding(get: { picked != nil }, set: { if !$0 { picked = nil } }),
      titleVisibility: .visible
    ) {
      Button("Merge") { Task { await merge() } }
      Button("Cancel", role: .cancel) { picked = nil }
    }
    .seen(model.core, "merge", into)
  }

  private func merge() async {
    guard let picked else { return }
    do {
      let r = try await model.core.call("merge", ["into": .string(into), "from": [.string(picked.id)]])
      model.done = Model.Done(text: "Merged \(picked.name)", batch: r["batch"].str)
      dismiss()
    } catch {
      problem = error.localizedDescription
    }
  }
}
