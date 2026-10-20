using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CharterDeskTracker;

public sealed class Booking
{
    public long Id;
    public string Flt = "", Kind = "", Status = "", From = "", To = "", Reg = "", Type = "", TypeName = "";
    public int Dist, Pax;
    public DateTime? DepAt;
    public double FromLat, FromLon, ToLat, ToLon;
    public List<string> SimMatch = new();

    public override string ToString() =>
        $"{Flt}  {From} → {To}  {Reg} ({Type})  {(Kind == "ferry" ? "positioning" : Pax + " pax")}";
}

/// <summary>Settings saved in %APPDATA%\CharterDeskTracker\config.json.</summary>
public sealed class Config
{
    public string Url { get; set; } = "";
    public string AnonKey { get; set; } = "";
    public string TrackerKey { get; set; } = "";

    static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CharterDeskTracker");
    static string FilePath => Path.Combine(Dir, "config.json");
    public static string PendingDir => Path.Combine(Dir, "unsent");

    public bool IsComplete => Url.StartsWith("https://") && AnonKey.Length > 20 && TrackerKey.Length > 20;

    public static Config Load()
    {
        try { return JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath)) ?? new Config(); }
        catch { return new Config(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>The web app's Profile page shows one setup code: base64 of {"u":url,"a":anonKey,"k":trackerKey}.</summary>
    public static Config FromSetupCode(string code)
    {
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(code.Trim()));
        var o = JsonNode.Parse(json)!.AsObject();
        return new Config
        {
            Url = o["u"]!.GetValue<string>().TrimEnd('/'),
            AnonKey = o["a"]!.GetValue<string>(),
            TrackerKey = o["k"]!.GetValue<string>()
        };
    }
}

public sealed class Api
{
    readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };
    readonly Config _cfg;

    public Api(Config cfg)
    {
        _cfg = cfg;
        _http.DefaultRequestHeaders.Add("apikey", cfg.AnonKey);
        // Legacy anon keys are JWTs and go in both headers; newer publishable keys only go in "apikey".
        if (cfg.AnonKey.StartsWith("eyJ"))
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", cfg.AnonKey);
    }

    async Task<JsonNode> Rpc(string fn, JsonObject args)
    {
        args["p_key"] = _cfg.TrackerKey;
        using var content = new StringContent(args.ToJsonString(), Encoding.UTF8, "application/json");
        using var res = await _http.PostAsync($"{_cfg.Url}/rest/v1/rpc/{fn}", content);
        var body = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
        {
            string msg = body;
            try { msg = JsonNode.Parse(body)?["message"]?.GetValue<string>() ?? body; } catch { }
            throw new ApiException(msg, (int)res.StatusCode);
        }
        return string.IsNullOrWhiteSpace(body) ? null : JsonNode.Parse(body);
    }

    public async Task<(string pilot, List<Booking> trips)> Session()
    {
        var r = await Rpc("tracker_session", new JsonObject());
        var p = r!["pilot"]!;
        var pilot = $"{p["callsign"]} · {p["name"]} · {p["company"]}";
        var list = new List<Booking>();
        foreach (var t in r["trips"]!.AsArray())
        {
            var b = new Booking
            {
                Id = t!["id"]!.GetValue<long>(),
                Flt = S(t["flt"]), Kind = S(t["kind"]), Status = S(t["status"]),
                From = S(t["from"]), To = S(t["to"]), Reg = S(t["reg"]), Type = S(t["type"]), TypeName = S(t["type_name"]),
                Dist = t["dist"]?.GetValue<int>() ?? 0, Pax = t["pax"]?.GetValue<int>() ?? 0,
                FromLat = t["from_lat"]!.GetValue<double>(), FromLon = t["from_lon"]!.GetValue<double>(),
                ToLat = t["to_lat"]!.GetValue<double>(), ToLon = t["to_lon"]!.GetValue<double>(),
            };
            if (t["dep_at"] is JsonNode d && DateTime.TryParse(d.GetValue<string>(), null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var dt)) b.DepAt = dt;
            if (t["sim_match"] is JsonArray sm) foreach (var w in sm) b.SimMatch.Add(S(w));
            list.Add(b);
        }
        return (pilot, list);
    }

    public Task Start(long trip) => Rpc("tracker_start", new JsonObject { ["p_trip"] = trip });

    public Task Position(long trip, Sample s, Phase phase) => Rpc("tracker_position", new JsonObject
    {
        ["p_trip"] = trip, ["p_lat"] = Math.Round(s.Lat, 5), ["p_lon"] = Math.Round(s.Lon, 5),
        ["p_alt"] = (int)s.AltFt, ["p_gs"] = (int)s.GsKt, ["p_hdg"] = (int)s.HdgTrue, ["p_phase"] = phase.ToString()
    });

    public async Task<JsonNode> File(long trip, JsonObject report)
    {
        return await Rpc("tracker_file", new JsonObject { ["p_trip"] = trip, ["d"] = report });
    }

    static string S(JsonNode n) => n?.GetValue<string>() ?? "";
}

public sealed class ApiException : Exception
{
    public int Status { get; }
    public ApiException(string message, int status) : base(message) { Status = status; }
}
