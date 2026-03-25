import Foundation

struct DashboardResponse: Codable {
    let paair: PaairStatus
    let ollama: OllamaStatus
    let n8n: ServiceStatus
    let today: EmailStats
    let pendingEscalations: Int
    let recentEmails: [RecentEmail]

    enum CodingKeys: String, CodingKey {
        case paair, ollama, n8n, today
        case pendingEscalations = "pending_escalations"
        case recentEmails = "recent_emails"
    }
}

struct PaairStatus: Codable {
    let status: String
    let version: String
    let timestamp: String
}

struct OllamaStatus: Codable {
    let status: String
    let model: String?
}

struct ServiceStatus: Codable {
    let status: String
}

struct EmailStats: Codable {
    let date: String
    let total: Int
    let responded: Int
    let escalated: Int
    let rateLimited: Int
    let blocked: Int
    let errors: Int

    enum CodingKeys: String, CodingKey {
        case date, total, responded, escalated, blocked, errors
        case rateLimited = "rate_limited"
    }
}

struct RecentEmail: Codable, Identifiable {
    let fromAddress: String
    let subject: String
    let action: String
    let processedAt: String?

    var id: String { "\(fromAddress)-\(subject)-\(processedAt ?? "")" }

    /// Short display name: first part of the email address before @.
    var shortFrom: String {
        fromAddress.components(separatedBy: "@").first ?? fromAddress
    }

    /// Truncated subject for menu display.
    var shortSubject: String {
        subject.count > 40 ? String(subject.prefix(37)) + "..." : subject
    }

    enum CodingKeys: String, CodingKey {
        case fromAddress = "from_address"
        case subject, action
        case processedAt = "processed_at"
    }
}
