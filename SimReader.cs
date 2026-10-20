using FSUIPC;

namespace CharterDeskTracker;

/// <summary>One snapshot of the aircraft, already converted to everyday units.</summary>
public sealed class Sample
{
    public DateTime Utc;
    public double Lat, Lon, AltFt, GsKt, IasKt, VsFpm, HdgTrue, G;
    public double TouchdownVsFpm;   // FSUIPC's held vertical speed from the last airborne moment
    public double SimRate = 1, FuelLb;
    public bool OnGround, Paused, Slew, Crashed, ParkingBrake, EnginesRunning;
    public string Title = "";
}

/// <summary>Reads the sim through FSUIPC7 (MSFS), FSUIPC6 (P3D) or XPUIPC (X-Plane).</summary>
public sealed class SimReader : IDisposable
{
    // Offsets from the FSUIPC offset status document.
    readonly Offset<long> _lat = new(0x0560);
    readonly Offset<long> _lon = new(0x0568);
    readonly Offset<long> _alt = new(0x0570);
    readonly Offset<uint> _hdg = new(0x0580);
    readonly Offset<int> _gs = new(0x02B4);    // m/s * 65536
    readonly Offset<int> _ias = new(0x02BC);   // kt * 128
    readonly Offset<int> _vs = new(0x02C8);    // m/s * 256
    readonly Offset<int> _tdVs = new(0x030C);  // m/s * 256, held while on ground
    readonly Offset<short> _onGround = new(0x0366);
    readonly Offset<short> _g = new(0x11BA);   // G * 625
    readonly Offset<short> _paused = new(0x0264);
    readonly Offset<short> _simRate = new(0x0C1A); // rate * 256
    readonly Offset<short> _slew = new(0x05DC);
    readonly Offset<short> _crashed = new(0x0840);
    readonly Offset<short> _parkBrake = new(0x0BC8);
    readonly Offset<short> _eng1 = new(0x0894);
    readonly Offset<short> _eng2 = new(0x092C);
    readonly Offset<short> _eng3 = new(0x09C4);
    readonly Offset<short> _eng4 = new(0x0A5C);
    readonly Offset<int> _fuelLb = new(0x126C);
    readonly Offset<string> _title = new(0x3D00, 256);

    public string SimName { get; private set; } = "";
    public bool IsOpen => FSUIPCConnection.IsOpen;

    public bool TryConnect(out string error)
    {
        try
        {
            if (!FSUIPCConnection.IsOpen) FSUIPCConnection.Open();
            SimName = FSUIPCConnection.FlightSimVersionConnected.ToString();
            error = "";
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public Sample Read()
    {
        FSUIPCConnection.Process();
        const double two32 = 65536.0 * 65536.0;
        var s = new Sample
        {
            Utc = DateTime.UtcNow,
            Lat = _lat.Value * 90.0 / (10001750.0 * two32),
            Lon = _lon.Value * 360.0 / (two32 * two32),
            AltFt = _alt.Value / two32 * 3.28084,
            HdgTrue = (_hdg.Value * 360.0 / two32 + 360) % 360,
            GsKt = _gs.Value / 65536.0 * 1.943844,
            IasKt = _ias.Value / 128.0,
            VsFpm = _vs.Value / 256.0 * 196.850394,
            TouchdownVsFpm = _tdVs.Value / 256.0 * 196.850394,
            OnGround = _onGround.Value != 0,
            G = _g.Value / 625.0,
            Paused = _paused.Value != 0,
            SimRate = _simRate.Value > 0 ? _simRate.Value / 256.0 : 1,
            Slew = _slew.Value != 0,
            Crashed = _crashed.Value != 0,
            ParkingBrake = _parkBrake.Value > 16000,
            EnginesRunning = _eng1.Value != 0 || _eng2.Value != 0 || _eng3.Value != 0 || _eng4.Value != 0,
            FuelLb = _fuelLb.Value,
            Title = (_title.Value ?? "").Trim('\0', ' ')
        };
        return s;
    }

    public void Dispose()
    {
        try { FSUIPCConnection.Close(); } catch { /* already closed */ }
    }
}
