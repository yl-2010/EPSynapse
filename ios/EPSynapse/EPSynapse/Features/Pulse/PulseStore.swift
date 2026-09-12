import Combine
import Foundation

@MainActor
final class PulseStore: ObservableObject {
    static let boardURL = URL(string: "https://epsynapse.com/board")!
    static let school = "eastside-prep"

    @Published var pulse: Pulse = FallbackLPC.pulse()
    @Published var results: PulseResults?
    @Published var status = ""
    @Published var usingFallback = false
    @Published var isLoading = false
    @Published var isVoting = false
    @Published var answers: [String: String] = [:]
    @Published var grade = ""

    private let api = APIClient.shared

    var canSubmit: Bool {
        guard !pulse.voted, !isVoting, pulse.status == "open" else { return false }
        return pulse.questions.allSatisfy { question in
            let pick = answers[question.id] ?? ""
            return !pick.isEmpty
        }
    }

    func load(sessionId: String) async {
        isLoading = true
        defer { isLoading = false }

        _ = PulseVoter.id()
        do {
            let path = "/v1/pulses/current?school=\(Self.school)"
            let wrapped: PulseCurrentResponse = try await api.request(path, sessionId: sessionId)
            applyPulse(wrapped.pulse)
            usingFallback = false
            status = ""
            if pulse.voted {
                await loadResults(sessionId: sessionId)
            }
        } catch let error as APIError where error.status == 404 {
            useFallback(message: FallbackLPC.statusLine)
        } catch {
            useFallback(message: FallbackLPC.statusLine)
        }
    }

    func vote(sessionId: String) async {
        guard canSubmit else { return }
        isVoting = true
        defer { isVoting = false }

        let body = PulseVoteBody(answers: answers, grade: grade)
        let path = "/v1/pulses/\(pulse.id)/vote"
        do {
            let voted: PulseVoteResponse = try await api.request(
                path,
                method: "POST",
                body: body,
                sessionId: sessionId
            )
            if let next = voted.pulse {
                applyPulse(next)
            } else {
                pulse.voted = true
                pulse.myAnswers = answers
            }
            if let nextResults = voted.results {
                results = nextResults
            } else {
                await loadResults(sessionId: sessionId)
            }
            usingFallback = false
            status = ""
        } catch let error as APIError where error.status == 409 {
            pulse.voted = true
            status = "Already counted."
            await load(sessionId: sessionId)
        } catch let error as APIError where error.status == 404 {
            useFallback(message: "Vote did not reach the server. Pulse API is not up yet.")
        } catch {
            status = (error as? APIError)?.message ?? "Could not send the vote."
        }
    }

    func loadResults(sessionId: String) async {
        let id = pulse.id
        guard !id.isEmpty else { return }
        do {
            let fetched: PulseResults = try await api.request(
                "/v1/pulses/\(id)/results",
                sessionId: sessionId
            )
            results = fetched
        } catch {
            if results == nil, usingFallback {
                status = status.isEmpty ? FallbackLPC.statusLine : status
            }
        }
    }

    func resetDraftFromPulse() {
        var next: [String: String] = [:]
        for question in pulse.questions {
            if let pick = pulse.myAnswers[question.id], !pick.isEmpty {
                next[question.id] = pick
            }
        }
        answers = next
        let g = pulse.myAnswers["grade"] ?? ""
        grade = pulse.grades.contains(g) ? g : ""
    }

    private func applyPulse(_ next: Pulse) {
        pulse = next
        resetDraftFromPulse()
    }

    private func useFallback(message: String) {
        usingFallback = true
        status = message
        if pulse.id.isEmpty || pulse.questions.isEmpty {
            pulse = FallbackLPC.pulse()
        }
        if pulse.questions.isEmpty {
            pulse = FallbackLPC.pulse()
        }
        if answers.isEmpty {
            resetDraftFromPulse()
        }
    }
}
