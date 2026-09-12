import Foundation

enum PulseVoter {
    static let defaultsKey = "eps.voter"

    static func id() -> String {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: defaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            existing.count >= 8
        {
            return existing
        }
        let created = UUID().uuidString
        defaults.set(created, forKey: defaultsKey)
        return created
    }
}

struct PulseOption: Identifiable, Equatable, Hashable {
    var id: String
    var label: String

    init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id)
        label = c.string(.label)
    }

    private enum CodingKeys: String, CodingKey {
        case id, label
    }
}

extension PulseOption: Decodable {}

struct PulseQuestion: Identifiable, Equatable {
    var id: String
    var prompt: String
    var kind: String
    var options: [PulseOption]

    init(id: String, prompt: String, kind: String = "single", options: [PulseOption]) {
        self.id = id
        self.prompt = prompt
        self.kind = kind
        self.options = options
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id)
        prompt = c.string(.prompt)
        kind = c.string(.kind)
        if kind.isEmpty { kind = "single" }
        options = (try? c.decodeIfPresent([PulseOption].self, forKey: .options)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id, prompt, kind, options
    }
}

extension PulseQuestion: Decodable {}

struct Pulse: Identifiable, Equatable {
    var id: String
    var topic: String
    var title: String
    var blurb: String
    var status: String
    var questions: [PulseQuestion]
    var grades: [String]
    var voted: Bool
    var myAnswers: [String: String]

    init(
        id: String,
        topic: String = "LPC",
        title: String = "This week's LPC",
        blurb: String = "",
        status: String = "open",
        questions: [PulseQuestion] = [],
        grades: [String] = ["9", "10", "11", "12"],
        voted: Bool = false,
        myAnswers: [String: String] = [:]
    ) {
        self.id = id
        self.topic = topic
        self.title = title
        self.blurb = blurb
        self.status = status
        self.questions = questions
        self.grades = grades
        self.voted = voted
        self.myAnswers = myAnswers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id)
        topic = c.string(.topic)
        title = c.string(.title)
        blurb = c.string(.blurb)
        status = c.string(.status)
        questions = (try? c.decodeIfPresent([PulseQuestion].self, forKey: .questions)) ?? []
        grades = (try? c.decodeIfPresent([String].self, forKey: .grades)) ?? ["9", "10", "11", "12"]
        voted = c.bool(.voted)
        myAnswers = Self.decodeAnswers(c)
        if title.isEmpty { title = "This week's LPC" }
        if status.isEmpty { status = "open" }
    }

    private static func decodeAnswers(_ c: KeyedDecodingContainer<CodingKeys>) -> [String: String] {
        if let map = try? c.decodeIfPresent([String: String].self, forKey: .myAnswers) {
            return map
        }
        return [:]
    }

    private enum CodingKeys: String, CodingKey {
        case id, topic, title, blurb, status, questions, grades, voted, myAnswers
    }
}

extension Pulse: Decodable {}

struct PulseCurrentResponse: Decodable {
    var pulse: Pulse

    init(pulse: Pulse) {
        self.pulse = pulse
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let wrapped = try? c.decode(Pulse.self, forKey: .pulse) {
            pulse = wrapped
        } else {
            pulse = try Pulse(from: decoder)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case pulse
    }
}

struct PulseResultOption: Identifiable, Equatable {
    var id: String
    var label: String
    var count: Int
    var pct: Int

    init(id: String, label: String, count: Int = 0, pct: Int = 0) {
        self.id = id
        self.label = label
        self.count = count
        self.pct = pct
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id)
        label = c.string(.label)
        count = c.int(.count)
        pct = c.int(.pct)
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, count, pct
    }
}

extension PulseResultOption: Decodable {}

struct PulseResultQuestion: Identifiable, Equatable {
    var id: String
    var prompt: String
    var options: [PulseResultOption]

    init(id: String, prompt: String, options: [PulseResultOption]) {
        self.id = id
        self.prompt = prompt
        self.options = options
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id)
        prompt = c.string(.prompt)
        options = (try? c.decodeIfPresent([PulseResultOption].self, forKey: .options)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id, prompt, options
    }
}

extension PulseResultQuestion: Decodable {}

struct PulseResults: Equatable {
    var id: String
    var title: String
    var n: Int
    var questions: [PulseResultQuestion]

    init(id: String = "", title: String = "", n: Int = 0, questions: [PulseResultQuestion] = []) {
        self.id = id
        self.title = title
        self.n = n
        self.questions = questions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id)
        title = c.string(.title)
        n = c.int(.n)
        questions = (try? c.decodeIfPresent([PulseResultQuestion].self, forKey: .questions)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, n, questions
    }
}

extension PulseResults: Decodable {}

struct PulseVoteBody: Encodable {
    var answers: [String: String]
    var grade: String?

    enum CodingKeys: String, CodingKey {
        case answers, grade
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(answers, forKey: .answers)
        if let grade, !grade.isEmpty {
            try c.encode(grade, forKey: .grade)
        }
    }
}

struct PulseVoteResponse: Decodable {
    var pulse: Pulse?
    var results: PulseResults?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let wrapped = try? c.decode(PulseCurrentResponse.self, forKey: .payload) {
            pulse = wrapped.pulse
        } else {
            pulse = try? c.decode(Pulse.self, forKey: .pulse)
        }
        results = try? c.decode(PulseResults.self, forKey: .results)
    }

    private enum CodingKeys: String, CodingKey {
        case payload, pulse, results
    }
}

enum FallbackLPC {
    static let statusLine = "Pulse API is not up yet. You can still pick answers."

    static func pulse() -> Pulse {
        Pulse(
            id: "lpc-2026-09",
            topic: "LPC",
            title: "This week's LPC",
            blurb: "Four questions. Counts only. No names on the board.",
            status: "open",
            questions: [
                PulseQuestion(
                    id: "keep",
                    prompt: "Keep the current LPC mains?",
                    options: [
                        PulseOption(id: "keep", label: "Keep them"),
                        PulseOption(id: "drop", label: "Drop them"),
                        PulseOption(id: "rotate", label: "Rotate weekly"),
                    ]
                ),
                PulseQuestion(
                    id: "add",
                    prompt: "What should LPC add next?",
                    options: [
                        PulseOption(id: "protein", label: "More protein"),
                        PulseOption(id: "veg", label: "Better vegetarian"),
                        PulseOption(id: "hot", label: "A hot line that is not pizza"),
                        PulseOption(id: "late", label: "A window after 1pm"),
                    ]
                ),
                PulseQuestion(
                    id: "diet",
                    prompt: "Dietary gap you hit most?",
                    options: [
                        PulseOption(id: "none", label: "None"),
                        PulseOption(id: "veg", label: "Vegetarian"),
                        PulseOption(id: "vegan", label: "Vegan"),
                        PulseOption(id: "gluten", label: "Gluten"),
                        PulseOption(id: "kosher", label: "Kosher or halal"),
                    ]
                ),
                PulseQuestion(
                    id: "wait",
                    prompt: "Peak wait in the line?",
                    options: [
                        PulseOption(id: "fast", label: "Under 3 min"),
                        PulseOption(id: "ok", label: "3 to 6"),
                        PulseOption(id: "slow", label: "6 to 10"),
                        PulseOption(id: "dead", label: "More than 10"),
                    ]
                ),
            ]
        )
    }
}

private extension KeyedDecodingContainer {
    func string(_ key: Key) -> String {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return String(value) }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return String(Int(value)) }
        return ""
    }

    func bool(_ key: Key) -> Bool {
        (try? decodeIfPresent(Bool.self, forKey: key)) ?? false
    }

    func int(_ key: Key) -> Int {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return Int(value) }
        if let raw = try? decodeIfPresent(String.self, forKey: key), let value = Int(raw) {
            return value
        }
        return 0
    }
}
