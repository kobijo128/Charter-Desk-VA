using System.Text.Json.Nodes;

namespace CharterDeskTracker;

public enum Phase { Waiting, TaxiOut, TakeoffRoll, Climb, Cruise, Descent, Landed, TaxiIn, Arrived }

/// <summary>
/// Turns a stream of sim samples into a flight: phases, block times, landing quality and checks.
/// Feed it about four samples a second with Update().
/// </summary>
public sealed class FlightRecorder
{
    public Booking Booking { get; }
    public Phase Phase { get; private set; } = Phase.Waiting;
    public string Sim { get; set; } = "";
    public string AircraftTitle { get; private set; } = "";

    public DateTime? BlockOff, Takeoff, Landing, BlockOn;
    public double DepLat, DepLon, ArrLat, ArrLon;
    public double? LandingFpm, LandingG;
    public int Bounces;
    public double DistanceNm;
    public double MaxSimRate = 1;
    public bool SlewSeen, CrashSeen;
    public double OverspeedSeconds;
    public double FuelStart, FuelEnd;

    readonly List<double[]> _path = new();
    Sample _last;
    DateTime _lastPathPoint = DateTime.MinValue;
    DateTime? _touchdownAt, _stoppedSince, _airborneSince;
    double _lastAirborneVs;

    public event Action<string> Log;
    public event Action Arrived;

    public FlightRecorder(Booking booking) { Booking = booking; }

    public void Update(Sample s)
    {
        if (s.Paused) { _last = s; return; }
        if (!string.IsNullOrEmpty(s.Title)) AircraftTitle = s.Title;

        // integrity tracking, only while the flight is actually under way
        if (Phase != Phase.Waiting && Phase != Phase.Arrived)
        {
            MaxSimRate = Math.Max(MaxSimRate, s.SimRate);
            if (s.Slew) SlewSeen = true;
            if (s.Crashed) CrashSeen = true;
            if (!s.OnGround && s.AltFt < 10000 && s.IasKt > 255 && _last != null)
                OverspeedSeconds += (s.Utc - _last.Utc).TotalSeconds;
            if (_last != null && s.GsKt > 2)
            {
                var d = Geo.Nm(_last.Lat, _last.Lon, s.Lat, s.Lon);
                if (d < 5) DistanceNm += d; // ignore teleports; slew flag catches those
            }
            if ((s.Utc - _lastPathPoint).TotalSeconds >= (s.OnGround ? 20 : 30) && _path.Count < 3900)
            {
                _path.Add(new[] { Math.Round(s.Lat, 5), Math.Round(s.Lon, 5), Math.Round(s.AltFt) });
                _lastPathPoint = s.Utc;
            }
        }
        if (!s.OnGround) _lastAirborneVs = s.VsFpm;

        switch (Phase)
        {
            case Phase.Waiting:
                if (s.OnGround && s.GsKt > 3)
                {
                    BlockOff = s.Utc; DepLat = s.Lat; DepLon = s.Lon; FuelStart = s.FuelLb;
                    SetPhase(Phase.TaxiOut, $"Block off at {s.Utc:HH:mm}Z");
                }
                break;

            case Phase.TaxiOut:
                if (s.OnGround && s.GsKt > 40) SetPhase(Phase.TakeoffRoll, "Takeoff roll");
                else if (!s.OnGround) Liftoff(s);
                break;

            case Phase.TakeoffRoll:
                if (!s.OnGround) Liftoff(s);
                else if (s.GsKt < 25) SetPhase(Phase.TaxiOut, "Rejected takeoff or back to taxi");
                break;

            case Phase.Climb:
            case Phase.Cruise:
            case Phase.Descent:
                if (s.OnGround) { Touchdown(s); break; }
                var next = s.VsFpm > 400 ? Phase.Climb : s.VsFpm < -400 ? Phase.Descent : Phase.Cruise;
                if (next != Phase) SetPhase(next, null);
                break;

            case Phase.Landed:
                if (!s.OnGround)
                {
                    _airborneSince ??= s.Utc;
                    // airborne again for a while: treat as a go-around or touch-and-go
                    if ((s.Utc - _airborneSince.Value).TotalSeconds > 20)
                    {
                        Landing = null; LandingFpm = null; LandingG = null; Bounces = 0; _touchdownAt = null;
                        SetPhase(Phase.Climb, "Go-around");
                    }
                    break;
                }
                if (_airborneSince != null) { Bounces++; _airborneSince = null; Log?.Invoke($"Bounce {Bounces}"); }
                if (_touchdownAt != null && (s.Utc - _touchdownAt.Value).TotalSeconds < 3)
                    LandingG = Math.Max(LandingG ?? 0, s.G);
                if (s.GsKt < 30) SetPhase(Phase.TaxiIn, "Taxiing in");
                break;

            case Phase.TaxiIn:
                bool parked = s.OnGround && s.GsKt < 1 && (s.ParkingBrake || !s.EnginesRunning);
                if (!parked) { _stoppedSince = null; if (!s.OnGround) SetPhase(Phase.Climb, "Airborne again"); break; }
                _stoppedSince ??= s.Utc;
                if ((s.Utc - _stoppedSince.Value).TotalSeconds >= 5)
                {
                    BlockOn = s.Utc; ArrLat = s.Lat; ArrLon = s.Lon; FuelEnd = s.FuelLb;
                    _path.Add(new[] { Math.Round(s.Lat, 5), Math.Round(s.Lon, 5), Math.Round(s.AltFt) });
                    SetPhase(Phase.Arrived, $"Block on at {s.Utc:HH:mm}Z");
                    Arrived?.Invoke();
                }
                break;
        }
        _last = s;
    }

    void Liftoff(Sample s)
    {
        Takeoff ??= s.Utc;
        SetPhase(Phase.Climb, $"Airborne at {s.Utc:HH:mm}Z");
    }

    void Touchdown(Sample s)
    {
        if (Landing == null)
        {
            Landing = s.Utc;
            _touchdownAt = s.Utc;
            // FSUIPC holds the last airborne vertical speed in 0x030C; fall back to our own sample
            var fpm = Math.Abs(s.TouchdownVsFpm) > 1 ? s.TouchdownVsFpm : _lastAirborneVs;
            LandingFpm = Math.Round(Math.Abs(fpm));
            LandingG = s.G;
            Log?.Invoke($"Touchdown {LandingFpm:0} fpm");
        }
        _airborneSince = null;
        SetPhase(Phase.Landed, null);
    }

    void SetPhase(Phase p, string message)
    {
        if (p == Phase) return;
        Phase = p;
        Log?.Invoke(message ?? p.ToString());
    }

    public JsonObject BuildReport(string trackerVersion)
    {
        var path = new JsonArray();
        foreach (var p in _path) path.Add(new JsonArray(p[0], p[1], p[2]));
        return new JsonObject
        {
            ["sim"] = Sim,
            ["aircraft_title"] = AircraftTitle,
            ["tracker_ver"] = trackerVersion,
            ["block_off"] = BlockOff?.ToString("o"),
            ["takeoff"] = Takeoff?.ToString("o") ?? "",
            ["landing"] = Landing?.ToString("o") ?? "",
            ["block_on"] = BlockOn?.ToString("o"),
            ["dep_lat"] = DepLat, ["dep_lon"] = DepLon,
            ["arr_lat"] = ArrLat, ["arr_lon"] = ArrLon,
            ["landing_fpm"] = LandingFpm,
            ["landing_g"] = LandingG.HasValue ? (double?)Math.Round(LandingG.Value, 2) : null,
            ["bounces"] = Bounces,
            ["fuel_used_lb"] = Math.Round(Math.Max(0, FuelStart - FuelEnd)),
            ["dist_flown"] = Math.Round(DistanceNm),
            ["max_sim_rate"] = Math.Round(MaxSimRate, 2),
            ["overspeed_s"] = (int)OverspeedSeconds,
            ["crashed"] = CrashSeen,
            ["slew"] = SlewSeen,
            ["path"] = path
        };
    }
}

public static class Geo
{
    public static double Nm(double lat1, double lon1, double lat2, double lon2)
    {
        const double r = Math.PI / 180;
        var a = Math.Pow(Math.Sin((lat2 - lat1) * r / 2), 2) +
                Math.Cos(lat1 * r) * Math.Cos(lat2 * r) * Math.Pow(Math.Sin((lon2 - lon1) * r / 2), 2);
        return 2 * 3440.065 * Math.Asin(Math.Min(1, Math.Sqrt(a)));
    }
}
