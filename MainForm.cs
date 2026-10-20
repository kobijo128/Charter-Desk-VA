using System.Drawing;
using System.Text.Json.Nodes;

namespace CharterDeskTracker;

public sealed class MainForm : Form
{
    const string Version = "0.1.0";

    Config _cfg = Config.Load();
    Api _api;
    readonly SimReader _sim = new();
    FlightRecorder _rec;
    Sample _lastSample;
    DateTime _lastPositionSent = DateTime.MinValue;
    bool _filing;

    readonly Label _pilot = new() { AutoSize = true, Font = new Font("Segoe UI Semibold", 11f) };
    readonly Label _simStatus = new() { AutoSize = true, ForeColor = Color.DimGray };
    readonly ListBox _bookings = new() { Dock = DockStyle.Fill, IntegralHeight = false, Font = new Font("Consolas", 10f) };
    readonly Button _refresh = new() { Text = "Refresh bookings", AutoSize = true };
    readonly Button _start = new() { Text = "Start flight", AutoSize = true, Enabled = false };
    readonly Button _abort = new() { Text = "Stop tracking", AutoSize = true, Enabled = false };
    readonly Button _setup = new() { Text = "Setup", AutoSize = true };
    readonly Button _retry = new() { Text = "Send saved reports", AutoSize = true, Visible = false };
    readonly Label _phase = new() { AutoSize = true, Font = new Font("Segoe UI Semibold", 16f), Text = "No flight" };
    readonly Label _live = new() { AutoSize = true, Font = new Font("Consolas", 10f) };
    readonly Label _landing = new() { AutoSize = true, Font = new Font("Consolas", 10f) };
    readonly TextBox _log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = new Font("Consolas", 9f) };
    readonly System.Windows.Forms.Timer _tick = new() { Interval = 250 };
    readonly System.Windows.Forms.Timer _connect = new() { Interval = 5000 };

    public MainForm()
    {
        Text = $"Charter Desk Tracker {Version}";
        Width = 720; Height = 640; MinimumSize = new Size(560, 480);
        Font = new Font("Segoe UI", 9.5f);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(12) };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 35));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 65));

        var top = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        top.Controls.AddRange(new Control[] { _pilot, _setup });
        root.Controls.Add(top);
        root.Controls.Add(_simStatus);
        root.Controls.Add(_bookings);

        var btns = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        btns.Controls.AddRange(new Control[] { _start, _refresh, _abort, _retry });
        root.Controls.Add(btns);

        var status = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown };
        status.Controls.AddRange(new Control[] { _phase, _live, _landing });
        root.Controls.Add(status);
        root.Controls.Add(_log);
        Controls.Add(root);

        _setup.Click += (_, _) => ShowSetup();
        _refresh.Click += async (_, _) => await LoadBookings();
        _bookings.SelectedIndexChanged += (_, _) => UpdateButtons();
        _start.Click += async (_, _) => await StartFlight();
        _abort.Click += (_, _) => StopTracking("Tracking stopped. The booking stays open; start it again from the gate.");
        _retry.Click += async (_, _) => await SendSaved();
        _tick.Tick += async (_, _) => await OnTick();
        _connect.Tick += (_, _) => TryConnect();

        Shown += async (_, _) =>
        {
            if (!_cfg.IsComplete) ShowSetup();
            else { _api = new Api(_cfg); await LoadBookings(); await SendSaved(); }
            TryConnect();
            _connect.Start();
            _tick.Start();
        };
        FormClosing += (_, e) =>
        {
            if (_rec != null && _rec.Phase != Phase.Arrived && _rec.Phase != Phase.Waiting &&
                MessageBox.Show(this, "A flight is being tracked. Close the tracker and lose it?", "Flight in progress",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                e.Cancel = true;
        };
        UpdateSavedButton();
    }

    void Log(string msg)
    {
        if (string.IsNullOrEmpty(msg)) return;
        _log.AppendText($"{DateTime.Now:HH:mm:ss}  {msg}{Environment.NewLine}");
    }

    void ShowSetup()
    {
        using var f = new Form { Text = "Tracker setup", Width = 520, Height = 220, FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, MaximizeBox = false, MinimizeBox = false };
        var lbl = new Label { Text = "Paste the tracker setup code from your Profile page in Charter Desk:", Dock = DockStyle.Top, Height = 36, Padding = new Padding(10, 10, 10, 0) };
        var box = new TextBox { Dock = DockStyle.Top, Multiline = true, Height = 70, Margin = new Padding(10) };
        var ok = new Button { Text = "Save", Dock = DockStyle.Bottom, Height = 34, DialogResult = DialogResult.OK };
        f.Controls.AddRange(new Control[] { ok, box, lbl });
        f.AcceptButton = ok;
        if (f.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            _cfg = Config.FromSetupCode(box.Text);
            _cfg.Save();
            _api = new Api(_cfg);
            Log("Setup saved.");
            _ = LoadBookings();
        }
        catch
        {
            MessageBox.Show(this, "That code wasn't recognised. Copy it again from the Profile page.", "Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void TryConnect()
    {
        if (_sim.IsOpen) { _simStatus.Text = $"Connected to {_sim.SimName} through FSUIPC"; _simStatus.ForeColor = Color.SeaGreen; return; }
        if (_sim.TryConnect(out var err))
        {
            _simStatus.Text = $"Connected to {_sim.SimName} through FSUIPC";
            _simStatus.ForeColor = Color.SeaGreen;
            Log($"Connected to {_sim.SimName}.");
        }
        else
        {
            _simStatus.Text = "Waiting for the sim. Start MSFS with FSUIPC7, P3D with FSUIPC6, or X-Plane with XPUIPC.";
            _simStatus.ForeColor = Color.DimGray;
        }
        UpdateButtons();
    }

    async Task LoadBookings()
    {
        if (_api == null) return;
        try
        {
            var (pilot, trips) = await _api.Session();
            _pilot.Text = pilot;
            _bookings.Items.Clear();
            foreach (var t in trips) _bookings.Items.Add(t);
            if (trips.Count == 0) Log("No bookings ready to fly. Win a bid or accept a call in Charter Desk, then refresh.");
            else _bookings.SelectedIndex = 0;
        }
        catch (Exception ex) { Log("Couldn't load bookings: " + ex.Message); }
        UpdateButtons();
    }

    void UpdateButtons()
    {
        bool tracking = _rec != null && _rec.Phase != Phase.Arrived;
        _start.Enabled = !tracking && _sim.IsOpen && _bookings.SelectedItem is Booking;
        _abort.Enabled = tracking;
        _bookings.Enabled = !tracking;
        _refresh.Enabled = !tracking;
    }

    async Task StartFlight()
    {
        if (_bookings.SelectedItem is not Booking b || _lastSample == null) return;
        var s = _lastSample;
        var dist = Geo.Nm(s.Lat, s.Lon, b.FromLat, b.FromLon);
        if (dist > 3)
        {
            MessageBox.Show(this, $"Your aircraft is {dist:0} nm from {b.From}. Load the flight at {b.From} first.", "Wrong airport", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        if (!s.OnGround || s.GsKt > 2)
        {
            MessageBox.Show(this, "Start tracking while parked at the gate or stand.", "Not parked", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        if (b.SimMatch.Count > 0 && !b.SimMatch.Any(w => s.Title.Contains(w, StringComparison.OrdinalIgnoreCase)) &&
            MessageBox.Show(this, $"The loaded aircraft is \"{s.Title}\", but this booking is for a {b.TypeName}. Staff will need to review the report. Start anyway?",
                "Aircraft type", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
            return;
        try
        {
            await _api.Start(b.Id);
        }
        catch (Exception ex) { Log("Couldn't start: " + ex.Message); return; }

        _rec = new FlightRecorder(b) { Sim = _sim.SimName };
        _rec.Log += Log;
        _rec.Arrived += async () => await FileReport();
        Log($"Tracking {b.Flt} {b.From} → {b.To}. Release the parking brake and taxi when ready.");
        _phase.Text = "Boarding";
        _landing.Text = "";
        UpdateButtons();
    }

    void StopTracking(string message)
    {
        _rec = null;
        _phase.Text = "No flight";
        Log(message);
        UpdateButtons();
    }

    async Task OnTick()
    {
        if (!_sim.IsOpen) return;
        Sample s;
        try { s = _sim.Read(); }
        catch (Exception ex)
        {
            Log("Lost the sim connection: " + ex.Message);
            _sim.Dispose();
            UpdateButtons();
            return;
        }
        _lastSample = s;
        _live.Text = $"{(s.OnGround ? "GND" : "AIR")}  GS {s.GsKt,4:0} kt  IAS {s.IasKt,4:0} kt  ALT {s.AltFt,6:0} ft  VS {s.VsFpm,6:0} fpm{(s.Paused ? "  PAUSED" : "")}";

        if (_rec == null) return;
        _rec.Update(s);
        _phase.Text = _rec.Phase switch
        {
            Phase.Waiting => "Boarding",
            Phase.TaxiOut => "Taxi out",
            Phase.TakeoffRoll => "Takeoff",
            Phase.Landed => "Landing",
            Phase.TaxiIn => "Taxi in",
            Phase.Arrived => "On blocks",
            var p => p.ToString()
        } + $"  ·  {_rec.Booking.Flt} {_rec.Booking.From} → {_rec.Booking.To}";
        if (_rec.LandingFpm.HasValue)
            _landing.Text = $"Landing {_rec.LandingFpm:0} fpm  {_rec.LandingG:0.00} G  bounces {_rec.Bounces}";

        if (_rec.Phase != Phase.Waiting && _rec.Phase != Phase.Arrived && (DateTime.UtcNow - _lastPositionSent).TotalSeconds >= 15)
        {
            _lastPositionSent = DateTime.UtcNow;
            try { await _api.Position(_rec.Booking.Id, s, _rec.Phase); } catch { /* live map only; ignore blips */ }
        }
    }

    async Task FileReport()
    {
        if (_filing || _rec == null) return;
        _filing = true;
        var rec = _rec;
        var report = rec.BuildReport(Version);
        Log("Filing flight report…");
        try
        {
            var res = await _api.File(rec.Booking.Id, report);
            ShowResult(res);
        }
        catch (Exception ex)
        {
            Directory.CreateDirectory(Config.PendingDir);
            File.WriteAllText(Path.Combine(Config.PendingDir, $"{rec.Booking.Id}.json"), report.ToJsonString());
            Log("Couldn't send the report (" + ex.Message + "). It's saved and will be sent when you press Send saved reports.");
            UpdateSavedButton();
        }
        finally
        {
            _filing = false;
            _rec = null;
            UpdateButtons();
            await LoadBookings();
        }
    }

    void ShowResult(JsonNode res)
    {
        var status = res?["status"]?.GetValue<string>() ?? "";
        if (status == "accepted")
        {
            var net = res["net"]?.GetValue<decimal>() ?? 0;
            var rep = res["rep_delta"]?.GetValue<decimal>() ?? 0;
            Log($"Report accepted. Net {(net < 0 ? "-" : "")}${Math.Abs(net):N0}, reputation {(rep >= 0 ? "+" : "")}{rep:0.0}. {res["note"]}");
        }
        else
        {
            var failed = new List<string>();
            if (res?["checks"] is JsonObject c)
                foreach (var kv in c)
                    if (kv.Value?["ok"]?.GetValue<bool>() == false) failed.Add(kv.Key);
            Log($"Report filed and waiting for staff review{(failed.Count > 0 ? " (checks to review: " + string.Join(", ", failed) + ")" : "")}.");
        }
        _phase.Text = "Report filed";
    }

    async Task SendSaved()
    {
        if (_api == null || !Directory.Exists(Config.PendingDir)) { UpdateSavedButton(); return; }
        foreach (var path in Directory.GetFiles(Config.PendingDir, "*.json"))
        {
            if (!long.TryParse(Path.GetFileNameWithoutExtension(path), out var tripId)) continue;
            try
            {
                var report = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
                var res = await _api.File(tripId, report);
                File.Delete(path);
                ShowResult(res);
            }
            catch (ApiException ex) when (ex.Status == 400)
            {
                Log($"Saved report for booking {tripId} was refused: {ex.Message}");
                File.Move(path, path + ".refused", true);
            }
            catch (Exception ex) { Log("Still can't send saved reports: " + ex.Message); break; }
        }
        UpdateSavedButton();
    }

    void UpdateSavedButton()
    {
        _retry.Visible = Directory.Exists(Config.PendingDir) && Directory.GetFiles(Config.PendingDir, "*.json").Length > 0;
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _sim.Dispose();
        base.OnFormClosed(e);
    }
}
