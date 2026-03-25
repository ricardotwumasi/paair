import SwiftUI

@main
struct PAAIRMenuBarApp: App {
    @StateObject private var dashboard = DashboardService()

    var body: some Scene {
        MenuBarExtra {
            VStack(alignment: .leading, spacing: 0) {
                // ── Service Status ──
                Section {
                    Label {
                        Text("PAAIR: \(dashboard.paairStatus)")
                    } icon: {
                        Image(systemName: statusIcon(for: dashboard.paairStatus, expected: "running"))
                            .foregroundColor(statusColor(for: dashboard.paairStatus, expected: "running"))
                    }

                    Label {
                        if let model = dashboard.ollamaModel {
                            Text("Ollama: \(dashboard.ollamaStatus) (\(model))")
                        } else {
                            Text("Ollama: \(dashboard.ollamaStatus)")
                        }
                    } icon: {
                        Image(systemName: statusIcon(for: dashboard.ollamaStatus, expected: "running"))
                            .foregroundColor(statusColor(for: dashboard.ollamaStatus, expected: "running"))
                    }

                    Label {
                        Text("n8n: \(dashboard.n8nStatus)")
                    } icon: {
                        Image(systemName: statusIcon(for: dashboard.n8nStatus, expected: "healthy"))
                            .foregroundColor(statusColor(for: dashboard.n8nStatus, expected: "healthy"))
                    }
                }

                Divider()

                // ── Today's Stats ──
                Section("Today") {
                    Text("\(dashboard.totalToday) emails processed")
                        .font(.headline)
                    if dashboard.totalToday > 0 {
                        Text("\(dashboard.responded) responded, \(dashboard.escalated) escalated")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        if dashboard.rateLimited > 0 || dashboard.blocked > 0 || dashboard.errors > 0 {
                            Text("\(dashboard.rateLimited) rate-limited, \(dashboard.blocked) blocked, \(dashboard.errors) errors")
                                .font(.subheadline)
                                .foregroundColor(.orange)
                        }
                    }
                    if dashboard.pendingEscalations > 0 {
                        Text("\(dashboard.pendingEscalations) pending escalation\(dashboard.pendingEscalations == 1 ? "" : "s")")
                            .font(.subheadline)
                            .foregroundColor(.orange)
                    }
                }

                Divider()

                // ── Recent Emails ──
                if !dashboard.recentEmails.isEmpty {
                    Section("Recent Emails") {
                        ForEach(dashboard.recentEmails) { email in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(email.shortFrom)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Text(email.shortSubject)
                                    .font(.caption2)
                                    .lineLimit(1)
                                Text(email.action)
                                    .font(.caption2)
                                    .foregroundColor(actionColor(email.action))
                            }
                            .padding(.vertical, 2)
                        }
                    }

                    Divider()
                }

                // ── Startup/Shutdown Log ──
                if !dashboard.startupLog.isEmpty {
                    Section("Progress") {
                        ForEach(Array(dashboard.startupLog.enumerated()), id: \.offset) { _, entry in
                            Text(entry)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                        if dashboard.isStarting || dashboard.isStopping {
                            Text("Please wait...")
                                .font(.caption2)
                                .foregroundColor(.blue)
                        }
                    }

                    Divider()
                }

                // ── Footer ──
                if let updated = dashboard.lastUpdated {
                    Text("Updated \(updated, style: .relative) ago")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .padding(.vertical, 2)
                }

                // ── Actions ──
                if dashboard.canStart {
                    Button("Start PAAIR") {
                        dashboard.startAll()
                    }
                    .keyboardShortcut("s")
                }

                if dashboard.canStop {
                    Button("Stop PAAIR") {
                        dashboard.stopAll()
                    }
                }

                Button("Refresh") {
                    dashboard.refresh()
                }
                .keyboardShortcut("r")

                Divider()

                Button("Quit PAAIR Menu Bar") {
                    NSApplication.shared.terminate(nil)
                }
                .keyboardShortcut("q")
            }
        } label: {
            Image(systemName: "brain")
                .symbolRenderingMode(.palette)
                .foregroundStyle(dashboard.iconColor)
        }
    }

    private func statusIcon(for status: String, expected: String) -> String {
        if status == expected {
            return "checkmark.circle.fill"
        } else if status == "unknown" || status == "unreachable" {
            return "questionmark.circle"
        } else {
            return "exclamationmark.triangle.fill"
        }
    }

    private func statusColor(for status: String, expected: String) -> Color {
        if status == expected { return .green }
        if status == "unknown" || status == "unreachable" { return .gray }
        return .red
    }

    private func actionColor(_ action: String) -> Color {
        switch action {
        case "responded": return .green
        case "escalated": return .orange
        case "error": return .red
        case "blocked", "rate_limited": return .yellow
        default: return .secondary
        }
    }
}
