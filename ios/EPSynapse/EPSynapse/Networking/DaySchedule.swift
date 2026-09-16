import Foundation

struct DayClass: Identifiable, Hashable {
    var id: String { "\(klass.id)-\(period)-\(start ?? "")" }
    let klass: SchoolClass
    let period: String
    let start: String?
    let end: String?
    let startMin: Int?
    let endMin: Int?
}

struct NextClassOccurrence: Hashable {
    let dateKey: String
    let start: String?
    let end: String?
}

struct DaySection: Identifiable, Hashable {
    var id: String { dateKey }
    let dateKey: String
    let typeCode: String?
    let whenLabel: String
    let isToday: Bool
    let nowMinutes: Int
    let classes: [DayClass]

    func isCurrent(_ dayClass: DayClass) -> Bool {
        guard isToday else { return false }
        if let end = dayClass.endMin {
            guard let highlightStart = EPSDaySchedule.highlightStartMin(for: dayClass, in: classes) else {
                return false
            }
            return nowMinutes >= highlightStart && nowMinutes < end
        }
        guard let now = EPSDaySchedule.currentPeriod() else { return false }
        let p = dayClass.period.uppercased()
        return p == now.num || p == now.letter
    }
}

enum EPSDaySchedule {
    static let highlightLeadMinutes = 10
    static let schoolDayEndBufferMinutes = 15

    static func currentPeriod(now: Date = Date(), calendar: Calendar = .current) -> (num: String, letter: String)? {
        let weekday = calendar.component(.weekday, from: now)
        if weekday == 1 || weekday == 7 { return nil }
        let minutes = calendar.component(.hour, from: now) * 60 + calendar.component(.minute, from: now)
        let bells: [(Int, Int, String, String)] = [
            (8 * 60, 8 * 60 + 50, "1", "A"),
            (8 * 60 + 55, 9 * 60 + 45, "2", "B"),
            (9 * 60 + 50, 10 * 60 + 40, "3", "C"),
            (10 * 60 + 45, 11 * 60 + 35, "4", "D"),
            (12 * 60 + 15, 13 * 60 + 5, "5", "E"),
            (13 * 60 + 10, 14 * 60, "6", "F"),
            (14 * 60 + 5, 14 * 60 + 55, "7", "G"),
            (15 * 60, 15 * 60 + 50, "8", "H"),
        ]
        guard let hit = bells.first(where: { minutes >= $0.0 && minutes < $0.1 }) else { return nil }
        return (hit.2, hit.3)
    }

    static func highlightStartMin(
        for dayClass: DayClass,
        in classes: [DayClass],
        leadMinutes: Int = highlightLeadMinutes
    ) -> Int? {
        guard let start = dayClass.startMin else { return nil }
        guard let idx = classes.firstIndex(where: { $0.id == dayClass.id }) else {
            return start - leadMinutes
        }
        if idx > 0, let prevEnd = classes[idx - 1].endMin {
            let gap = start - prevEnd
            if gap < leadMinutes { return prevEnd }
        }
        return start - leadMinutes
    }

    static func sections(
        classes: [SchoolClass],
        meetings: [ScheduleMeeting],
        bells: ScheduleBells?,
        isLLM: Bool,
        noBellTimes: Bool,
        todayKey: String,
        now: Date = Date()
    ) -> [DaySection] {
        let parts = ymd(now)
        let key = todayKey.isEmpty ? dateKey(parts) : todayKey

        if noBellTimes {
            return []
        }

        let showToday = schoolDayStillInSession(
            parts,
            classes: classes,
            meetings: meetings,
            bells: bells,
            isLLM: isLLM,
            todayKey: key
        )

        let day1: YMD?
        let day2: YMD?
        if showToday {
            day1 = parts
            day2 = nextSchoolDay(from: parts, classes: classes, bells: bells, isLLM: isLLM, skipToday: true)
        } else {
            day1 = nextSchoolDay(from: parts, classes: classes, bells: bells, isLLM: isLLM, skipToday: true)
            day2 = day1.flatMap {
                nextSchoolDay(from: $0, classes: classes, bells: bells, isLLM: isLLM, skipToday: true)
            }
        }

        var sections: [DaySection] = []
        if let day1 {
            let rows = classesForDay(
                day1,
                classes: classes,
                meetings: meetings,
                bells: bells,
                isLLM: isLLM,
                todayKey: key
            )
            if !rows.isEmpty || isSchoolDay(day1, classes: classes, bells: bells, isLLM: isLLM) {
                let title = daySectionTitle(day1, rows: rows, bells: bells, isLLM: isLLM)
                sections.append(DaySection(
                    dateKey: dateKey(day1),
                    typeCode: title.typeCode,
                    whenLabel: title.when,
                    isToday: showToday && dateKey(day1) == key,
                    nowMinutes: parts.minutes,
                    classes: rows
                ))
            }
        }
        if let day2 {
            let rows = classesForDay(
                day2,
                classes: classes,
                meetings: meetings,
                bells: bells,
                isLLM: isLLM,
                todayKey: key
            )
            if !rows.isEmpty {
                let title = daySectionTitle(day2, rows: rows, bells: bells, isLLM: isLLM)
                sections.append(DaySection(
                    dateKey: dateKey(day2),
                    typeCode: title.typeCode,
                    whenLabel: title.when,
                    isToday: false,
                    nowMinutes: parts.minutes,
                    classes: rows
                ))
            }
        }
        return sections.filter { !$0.classes.isEmpty }
    }

    static func nextOccurrence(
        for klass: SchoolClass,
        classes: [SchoolClass],
        meetings: [ScheduleMeeting],
        bells: ScheduleBells?,
        isLLM: Bool,
        noBellTimes: Bool,
        todayKey: String,
        now: Date = Date()
    ) -> NextClassOccurrence? {
        guard !noBellTimes else { return nil }
        var day = ymd(now)
        let key = todayKey.isEmpty ? dateKey(day) : todayKey
        for _ in 0..<21 {
            if isSchoolDay(day, classes: classes, bells: bells, isLLM: isLLM) {
                let rows = classesForDay(
                    day,
                    classes: classes,
                    meetings: meetings,
                    bells: bells,
                    isLLM: isLLM,
                    todayKey: key
                ).filter { $0.klass.id == klass.id }
                let isToday = dateKey(day) == key
                for row in rows {
                    if isToday, let end = row.endMin, day.minutes >= end { continue }
                    return NextClassOccurrence(dateKey: dateKey(day), start: row.start, end: row.end)
                }
            }
            guard let next = addDays(day, 1) else { break }
            day = next
        }
        return nil
    }

    // MARK: - Day construction

    private static func classesForDay(
        _ day: YMD,
        classes: [SchoolClass],
        meetings: [ScheduleMeeting],
        bells: ScheduleBells?,
        isLLM: Bool,
        todayKey: String
    ) -> [DayClass] {
        if isLLM {
            return llmClasses(on: day, classes: classes)
        }
        if let bells, !bells.weekdayPeriods.isEmpty, !bells.slots.isEmpty {
            return epsClasses(on: day, classes: classes, bells: bells)
        }
        if dateKey(day) == todayKey {
            return meetings.sorted { $0.startMinutes < $1.startMinutes }.compactMap { meeting in
                dayClass(from: meeting, classes: classes)
            }
        }
        return []
    }

    private static func llmClasses(on day: YMD, classes: [SchoolClass]) -> [DayClass] {
        let name = weekdayShort(day.weekday)
        var rows: [DayClass] = []
        for klass in classes {
            for meeting in klass.meetings where meeting.day == name {
                let startMin = timeToMinutes(meeting.start)
                let endMin = timeToMinutes(meeting.end)
                rows.append(DayClass(
                    klass: klass,
                    period: klass.period,
                    start: meeting.start.isEmpty ? nil : meeting.start,
                    end: meeting.end.isEmpty ? nil : meeting.end,
                    startMin: startMin,
                    endMin: endMin
                ))
            }
        }
        return rows.sorted { ($0.startMin ?? Int.max) < ($1.startMin ?? Int.max) }
    }

    private static func epsClasses(on day: YMD, classes: [SchoolClass], bells: ScheduleBells) -> [DayClass] {
        let letters = bells.weekdayPeriods[String(day.weekday)] ?? []
        var rows: [DayClass] = []
        for (i, letterRaw) in letters.enumerated() {
            guard i < bells.slots.count else { break }
            let period = letterRaw.uppercased()
            guard !period.isEmpty else { continue }
            let slot = bells.slots[i]
            let klass = classForPeriod(period, in: classes) ?? SchoolClass(
                id: "free-\(period)",
                name: "Free Period",
                period: period,
                freePeriod: true
            )
            rows.append(DayClass(
                klass: klass,
                period: period,
                start: slot.start.isEmpty ? nil : slot.start,
                end: slot.end.isEmpty ? nil : slot.end,
                startMin: timeToMinutes(slot.start),
                endMin: timeToMinutes(slot.end)
            ))
        }
        return rows
    }

    private static func dayClass(from meeting: ScheduleMeeting, classes: [SchoolClass]) -> DayClass? {
        let klass = classes.first { candidate in
            if !meeting.classId.isEmpty, meeting.classId == candidate.id { return true }
            if !meeting.period.isEmpty, meeting.period == candidate.period { return true }
            return false
        } ?? SchoolClass(
            id: meeting.classId.isEmpty ? "\(meeting.title)-\(meeting.period)" : meeting.classId,
            name: meeting.title,
            period: meeting.period,
            freePeriod: meeting.freePeriod
        )
        return DayClass(
            klass: klass,
            period: meeting.period.isEmpty ? klass.period : meeting.period,
            start: meeting.start.isEmpty ? nil : meeting.start,
            end: meeting.end.isEmpty ? nil : meeting.end,
            startMin: timeToMinutes(meeting.start),
            endMin: timeToMinutes(meeting.end)
        )
    }

    private static func classForPeriod(_ period: String, in classes: [SchoolClass]) -> SchoolClass? {
        let matches = classes.filter { $0.period.uppercased() == period }
        guard !matches.isEmpty else { return nil }
        return matches.first(where: { !$0.freePeriod }) ?? matches[0]
    }

    private static func daySectionTitle(
        _ day: YMD,
        rows: [DayClass],
        bells: ScheduleBells?,
        isLLM: Bool
    ) -> (typeCode: String?, when: String) {
        let when = "\(weekdayShort(day.weekday)) \(day.m)/\(day.day)"
        let periods: [String]
        if !isLLM, let bells {
            periods = (bells.weekdayPeriods[String(day.weekday)] ?? [])
                .map { $0.uppercased() }
                .filter { !$0.isEmpty }
        } else {
            var seen = Set<String>()
            periods = rows.map(\.period).map { $0.uppercased() }.filter { period in
                guard !period.isEmpty else { return false }
                return seen.insert(period).inserted
            }
        }
        let type: String
        if periods.isEmpty {
            type = ""
        } else if periods.count == 1 {
            type = periods[0]
        } else {
            type = "\(periods[0])\(periods[periods.count - 1])"
        }
        return (type.isEmpty ? nil : type, when)
    }

    private static func schoolDayStillInSession(
        _ now: YMD,
        classes: [SchoolClass],
        meetings: [ScheduleMeeting],
        bells: ScheduleBells?,
        isLLM: Bool,
        todayKey: String
    ) -> Bool {
        guard isSchoolDay(now, classes: classes, bells: bells, isLLM: isLLM) else { return false }
        let rows = classesForDay(
            now,
            classes: classes,
            meetings: meetings,
            bells: bells,
            isLLM: isLLM,
            todayKey: todayKey
        )
        let lastEnd = rows.compactMap(\.endMin).max()
            ?? bells?.slots.compactMap { timeToMinutes($0.end) }.max()
            ?? (15 * 60)
        return now.minutes < lastEnd + schoolDayEndBufferMinutes
    }

    private static func isSchoolDay(
        _ day: YMD,
        classes: [SchoolClass],
        bells: ScheduleBells?,
        isLLM: Bool
    ) -> Bool {
        if day.weekday == 0 || day.weekday == 6 { return false }
        if isLLM {
            let name = weekdayShort(day.weekday)
            return classes.contains { klass in
                klass.meetings.contains { $0.day == name }
            }
        }
        if let bells, !bells.weekdayPeriods.isEmpty {
            return !(bells.weekdayPeriods[String(day.weekday)] ?? []).isEmpty
        }
        return day.weekday >= 1 && day.weekday <= 5
    }

    private static func nextSchoolDay(
        from start: YMD,
        classes: [SchoolClass],
        bells: ScheduleBells?,
        isLLM: Bool,
        skipToday: Bool
    ) -> YMD? {
        var day = start
        let hops = skipToday ? 1 : 0
        for i in hops..<16 {
            if i > 0 {
                guard let next = addDays(day, 1) else { return nil }
                day = next
            }
            if isSchoolDay(day, classes: classes, bells: bells, isLLM: isLLM) {
                return day
            }
        }
        return nil
    }

    // MARK: - Date bits

    private struct YMD {
        var y: Int
        var m: Int
        var day: Int
        var weekday: Int
        var minutes: Int
    }

    private static func ymd(_ date: Date) -> YMD {
        let calendar = Calendar.current
        return YMD(
            y: calendar.component(.year, from: date),
            m: calendar.component(.month, from: date),
            day: calendar.component(.day, from: date),
            weekday: calendar.component(.weekday, from: date) - 1,
            minutes: calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
        )
    }

    private static func dateKey(_ p: YMD) -> String {
        String(format: "%04d-%02d-%02d", p.y, p.m, p.day)
    }

    private static func addDays(_ p: YMD, _ n: Int) -> YMD? {
        let calendar = Calendar.current
        guard let base = calendar.date(from: DateComponents(year: p.y, month: p.m, day: p.day)),
              let next = calendar.date(byAdding: .day, value: n, to: base)
        else { return nil }
        return ymd(next)
    }

    private static func weekdayShort(_ weekday: Int) -> String {
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][max(0, min(6, weekday))]
    }

    private static func timeToMinutes(_ t: String?) -> Int? {
        guard let t, let match = t.wholeMatch(of: /^(\d{1,2}):(\d{2})$/) else { return nil }
        return Int(match.1)! * 60 + Int(match.2)!
    }
}
