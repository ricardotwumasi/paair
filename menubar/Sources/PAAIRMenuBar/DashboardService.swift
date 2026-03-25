import Foundation
import SwiftUI

@MainActor
final class DashboardService: ObservableObject {
    @Published var paairStatus = "unknown"
    @Published var ollamaStatus = "unknown"
    @Published var ollamaModel: String?
    @Published var n8nStatus = "unknown"
    @Published var responded = 0
    @Published var escalated = 0
    @Published var rateLimited = 0
    @Published var blocked = 0
    @Published var errors = 0
    @Published var totalToday = 0
    @Published var pendingEscalations = 0
    @Published var recentEmails: [RecentEmail] = []
    @Published var lastUpdated: Date?
    @Published var connectionError = false

    // Startup/shutdown state
    @Published var isStarting = false
    @Published var isStopping = false
    @Published var startupLog: [String] = []

    private var timer: Timer?
    private let projectPath = "/Users/k1812261/claude_code/PAAIR"

    /// Overall health for the menu bar icon colour.
    var overallHealth: OverallHealth {
        if connectionError || paairStatus == "unknown" {
            return .unknown
        }
        if paairStatus == "paused" {
            return .degraded
        }
        if ollamaStatus != "running" {
            return .critical
        }
        if n8nStatus != "healthy" {
            return .degraded
        }
        return .healthy
    }

    var iconColor: Color {
        switch overallHealth {
        case .healthy: return .green
        case .degraded: return .yellow
        case .critical: return .red
        case .unknown: return .gray
        }
    }

    /// Whether the Start button should be shown.
    var canStart: Bool {
        !isStarting && !isStopping && overallHealth != .healthy
    }

    /// Whether the Stop button should be shown.
    var canStop: Bool {
        !isStarting && !isStopping && paairStatus == "running"
    }

    enum OverallHealth {
        case healthy, degraded, critical, unknown
    }

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    deinit {
        timer?.invalidate()
    }

    func refresh() {
        Task {
            await fetchDashboard()
        }
    }

    // MARK: - Start All Services

    func startAll() {
        guard !isStarting else { return }
        isStarting = true
        startupLog = []

        Task.detached { [weak self] in
            await self?.doStartAll()
            await MainActor.run {
                self?.isStarting = false
                self?.refresh()
            }
        }
    }

    private func doStartAll() async {
        // Step 1: Ollama
        if await isReachable(url: "http://localhost:11434/api/tags") {
            await appendLog("Ollama already running")
        } else {
            await appendLog("Starting Ollama...")
            shellFireAndForget("open -a Ollama")
            if await pollUntilReachable(url: "http://localhost:11434/api/tags", interval: 2, timeout: 30) {
                await appendLog("Ollama is ready")
            } else {
                await appendLog("Ollama failed to start (timed out)")
                return
            }
        }

        // Step 2: Docker / n8n
        if await isReachable(url: "http://localhost:5678/healthz") {
            await appendLog("n8n already running")
        } else {
            // Ensure Docker Desktop is running first
            if !isDockerRunning() {
                await appendLog("Starting Docker Desktop...")
                shellFireAndForget("open -a Docker")
                if await pollUntilDockerReady(timeout: 60) {
                    await appendLog("Docker Desktop is ready")
                } else {
                    await appendLog("Docker Desktop failed to start (timed out)")
                    return
                }
            }
            await appendLog("Starting Docker services (n8n)...")
            let dockerResult = shellWait("docker compose up -d", cwd: projectPath)
            if !dockerResult.isEmpty {
                await appendLog("docker: \(dockerResult)")
            }
            await appendLog("Waiting for n8n to be healthy...")
            if await pollUntilReachable(url: "http://localhost:5678/healthz", interval: 5, timeout: 90) {
                await appendLog("n8n is ready")
            } else {
                await appendLog("n8n failed to start (timed out)")
                return
            }
        }

        // Step 3: PAAIR server
        if await isReachable(url: "http://localhost:3100/health") {
            await appendLog("PAAIR server already running")
        } else {
            await appendLog("Starting PAAIR server...")
            shellFireAndForget("cd \(projectPath) && nohup npx tsx src/index.ts > /tmp/paair.log 2>&1 &")
            if await pollUntilReachable(url: "http://localhost:3100/health", interval: 2, timeout: 20) {
                await appendLog("PAAIR server is ready")
            } else {
                // Check log for errors
                let logTail = shellWait("tail -5 /tmp/paair.log")
                await appendLog("PAAIR failed to start. Log: \(logTail)")
                return
            }
        }

        // Step 4: ngrok tunnel
        if isProcessRunning("ngrok") {
            await appendLog("ngrok tunnel already running")
        } else {
            await appendLog("Starting ngrok tunnel...")
            shellFireAndForget("ngrok http 3100")
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if isProcessRunning("ngrok") {
                await appendLog("ngrok tunnel active (casketlike-cuc-repletively.ngrok-free.dev)")
            } else {
                await appendLog("ngrok failed to start")
            }
        }

        await appendLog("All services started")
        await MainActor.run { [weak self] in
            self?.showNotification(title: "PAAIR", body: "All services are running.")
        }
    }

    // MARK: - Stop All Services

    func stopAll() {
        guard !isStopping else { return }
        isStopping = true
        startupLog = []

        Task.detached { [weak self] in
            await self?.doStopAll()
            await MainActor.run {
                self?.isStopping = false
                self?.refresh()
            }
        }
    }

    private func doStopAll() async {
        await appendLog("Stopping ngrok...")
        _ = shellWait("pkill ngrok || true")

        await appendLog("Stopping PAAIR server...")
        _ = shellWait("pkill -f 'tsx src/index.ts' || true")

        await appendLog("Stopping Docker services...")
        _ = shellWait("docker compose down", cwd: projectPath)

        await appendLog("All services stopped (Ollama left running)")
        await MainActor.run { [weak self] in
            self?.showNotification(title: "PAAIR", body: "Services stopped.")
        }
    }

    // MARK: - Dashboard Fetch

    private func fetchDashboard() async {
        guard let url = URL(string: "http://localhost:3100/api/dashboard") else { return }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let decoder = JSONDecoder()
            let dashboard = try decoder.decode(DashboardResponse.self, from: data)

            let oldPaair = paairStatus
            let oldOllama = ollamaStatus

            paairStatus = dashboard.paair.status
            ollamaStatus = dashboard.ollama.status
            ollamaModel = dashboard.ollama.model
            n8nStatus = dashboard.n8n.status
            totalToday = dashboard.today.total
            responded = dashboard.today.responded
            escalated = dashboard.today.escalated
            rateLimited = dashboard.today.rateLimited
            blocked = dashboard.today.blocked
            errors = dashboard.today.errors
            pendingEscalations = dashboard.pendingEscalations
            recentEmails = dashboard.recentEmails
            lastUpdated = Date()
            connectionError = false

            if oldPaair == "running" && paairStatus != "running" {
                showNotification(title: "PAAIR Alert", body: "PAAIR is now \(paairStatus).")
            }
            if oldOllama == "running" && ollamaStatus != "running" {
                showNotification(title: "PAAIR Alert", body: "Ollama is offline. Email responses will fail.")
            }
            if oldOllama != "running" && ollamaStatus == "running" && oldOllama != "unknown" {
                showNotification(title: "PAAIR", body: "Ollama is back online.")
            }
        } catch {
            // PAAIR server is unreachable; check Ollama and n8n directly
            connectionError = true
            paairStatus = "unreachable"
            ollamaStatus = await isReachable(url: "http://localhost:11434/api/tags") ? "running" : "offline"
            n8nStatus = await isReachable(url: "http://localhost:5678/healthz") ? "healthy" : "offline"
            lastUpdated = Date()
        }
    }

    // MARK: - Helpers

    private func appendLog(_ message: String) async {
        await MainActor.run { [weak self] in
            self?.startupLog.append(message)
        }
    }

    private nonisolated func isReachable(url urlString: String) async -> Bool {
        guard let url = URL(string: urlString) else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private nonisolated func pollUntilReachable(url: String, interval: UInt64, timeout: UInt64) async -> Bool {
        let deadline = Date().addingTimeInterval(TimeInterval(timeout))
        while Date() < deadline {
            if await isReachable(url: url) { return true }
            try? await Task.sleep(nanoseconds: interval * 1_000_000_000)
        }
        return false
    }

    /// Check if Docker daemon is responsive.
    private nonisolated func isDockerRunning() -> Bool {
        let result = shellWait("docker info > /dev/null 2>&1 && echo ok")
        return result.contains("ok")
    }

    /// Poll until Docker daemon is responsive.
    private nonisolated func pollUntilDockerReady(timeout: UInt64) async -> Bool {
        let deadline = Date().addingTimeInterval(TimeInterval(timeout))
        while Date() < deadline {
            if isDockerRunning() { return true }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
        return false
    }

    private nonisolated func isProcessRunning(_ name: String) -> Bool {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        process.arguments = ["-x", name]
        process.standardOutput = pipe
        process.standardError = pipe
        try? process.run()
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    /// Run a shell command, wait for it, and return combined stdout+stderr.
    private nonisolated func shellWait(_ command: String, cwd: String? = nil) -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", command]
        if let cwd = cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return "Process error: \(error.localizedDescription)"
        }
    }

    /// Run a shell command without waiting (fire and forget).
    private nonisolated func shellFireAndForget(_ command: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", command]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    private func showNotification(title: String, body: String) {
        let escapedTitle = title.replacingOccurrences(of: "\"", with: "\\\"")
        let escapedBody = body.replacingOccurrences(of: "\"", with: "\\\"")
        let script = "display notification \"\(escapedBody)\" with title \"\(escapedTitle)\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
}
